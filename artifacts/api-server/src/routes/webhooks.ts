import { Router, type IRouter } from "express";
import { eq, desc, and, gte } from "drizzle-orm";
import { db, callsTable, leadsTable, followupsTable, campaignRecipientsTable, campaignsTable } from "@workspace/db";
import { generateAgentReply, analyzeCallIntent, learnFromTranscript } from "../lib/openai";
import { speechToText, textToSpeech, detectLanguage } from "../lib/sarvam";
import { sendCallSummaryWhatsApp, sendBrochureWhatsApp } from "../lib/whatsapp";
import { knowledgeTable } from "@workspace/db";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// In-memory conversation state (per callSid)
const conversations = new Map<string, {
  leadId: number;
  leadName: string;
  language: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  transcript: string[];
}>();

router.post("/webhooks/exotel/inbound", async (req, res): Promise<void> => {
  const { CallSid, From, To, Direction } = req.body;
  req.log.info({ CallSid, From }, "Inbound call received");

  if (!CallSid) {
    res.status(400).json({ error: "Missing CallSid" });
    return;
  }

  // Find or create lead
  let lead = null;
  if (From) {
    const digits = From.replace(/\D/g, "");
    const phoneVariants = [digits, `+91${digits.slice(-10)}`, digits.slice(-10)];
    for (const phone of phoneVariants) {
      const [found] = await db.select().from(leadsTable).where(eq(leadsTable.phone, phone));
      if (found) { lead = found; break; }
    }
    if (!lead) {
      [lead] = await db.insert(leadsTable).values({
        name: From,
        phone: digits.slice(-10),
        status: "new",
        score: 0,
        source: "inbound_call",
      }).returning();
    }
  }

  // Create call log
  await db.insert(callsTable).values({
    leadId: lead?.id ?? 1,
    direction: Direction === "outbound" ? "outbound" : "inbound",
    status: "in_progress",
    exotelCallSid: CallSid,
  });

  // Initialize conversation state
  conversations.set(CallSid, {
    leadId: lead?.id ?? 0,
    leadName: lead?.name ?? "Customer",
    language: lead?.language ?? "hi-IN",
    history: [],
    transcript: [],
  });

  res.json({ received: true });
});

router.post("/webhooks/exotel/status", async (req, res): Promise<void> => {
  const { CallSid, Status, RecordingUrl, Duration } = req.body;
  req.log.info({ CallSid, Status }, "Call status update");

  if (!CallSid) {
    res.json({ received: true });
    return;
  }

  const convo = conversations.get(CallSid);

  // Update call record
  const [callRecord] = await db.select().from(callsTable).where(eq(callsTable.exotelCallSid, CallSid));
  if (!callRecord) {
    res.json({ received: true });
    return;
  }

  const dbStatus = mapExotelStatus(Status);
  const fullTranscript = convo?.transcript.join("\n") ?? "";

  if (dbStatus === "completed" && fullTranscript) {
    try {
      const analysis = await analyzeCallIntent(fullTranscript);

      await db.update(callsTable)
        .set({
          status: dbStatus,
          duration: Duration ? parseInt(Duration) : null,
          transcript: fullTranscript,
          summary: analysis.summary,
          intentDetected: analysis.intent,
          scoreAfterCall: analysis.score,
          languageDetected: analysis.language,
        })
        .where(eq(callsTable.exotelCallSid, CallSid));

      // Update lead score, status and language
      const newStatus = analysis.score >= 80 ? "hot" : analysis.score >= 50 ? "interested" : "contacted";
      await db.update(leadsTable)
        .set({
          score: analysis.score,
          status: newStatus,
          language: analysis.language,
          intentSummary: analysis.summary,
          lastCallId: callRecord.id,
        })
        .where(eq(leadsTable.id, callRecord.leadId));

      // Schedule follow-up if intent suggests future date
      if (analysis.followupDate && analysis.followupReason) {
        await db.insert(followupsTable).values({
          leadId: callRecord.leadId,
          scheduledAt: new Date(analysis.followupDate),
          reason: analysis.followupReason,
          intentLabel: analysis.intent,
          callId: callRecord.id,
          status: "pending",
        });
        await db.update(leadsTable)
          .set({ nextFollowupAt: new Date(analysis.followupDate) })
          .where(eq(leadsTable.id, callRecord.leadId));
      }

      // Send WhatsApp summary
      const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, callRecord.leadId));
      if (lead) {
        const sent = await sendCallSummaryWhatsApp(lead.phone, lead.name, analysis.summary, lead.interestedModel);
        if (sent) {
          await db.update(callsTable)
            .set({ whatsappSent: true })
            .where(eq(callsTable.id, callRecord.id));
        }

        // Send brochure if model known
        if (lead.interestedModel) {
          const [brochure] = await db.select().from(knowledgeTable)
            .where(eq(knowledgeTable.category, "brochure"));
          if (brochure?.fileUrl) {
            await sendBrochureWhatsApp(lead.phone, lead.name, lead.interestedModel, brochure.fileUrl);
          }
        }
      }

      // Self-learn from transcript
      await learnFromTranscript(fullTranscript, analysis.summary);

    } catch (err) {
      logger.error({ err, CallSid }, "Error processing call completion");
      await db.update(callsTable)
        .set({ status: dbStatus, duration: Duration ? parseInt(Duration) : null })
        .where(eq(callsTable.exotelCallSid, CallSid));
    }
  } else {
    await db.update(callsTable)
      .set({ status: dbStatus, duration: Duration ? parseInt(Duration) : null })
      .where(eq(callsTable.exotelCallSid, CallSid));
  }

  conversations.delete(CallSid);
  res.json({ received: true });
});

// ── BotSpace WhatsApp inbound reply webhook ───────────────────────────────────
// BotSpace POSTs inbound replies here. Configure this URL in BotSpace dashboard:
// https://<your-domain>/api/webhooks/whatsapp/inbound
router.post("/webhooks/whatsapp/inbound", async (req, res): Promise<void> => {
  // BotSpace sends: { from, message, type, timestamp, ... }
  // Support both BotSpace and generic WhatsApp Cloud API formats
  const body = req.body;

  // Extract phone and message text from various possible payload shapes
  let fromPhone: string | null = null;
  let messageText: string | null = null;

  // BotSpace format
  if (body.from && body.message) {
    fromPhone = String(body.from).replace(/\D/g, "").slice(-10);
    messageText = typeof body.message === "string" ? body.message : body.message?.text ?? null;
  }
  // WhatsApp Cloud API format
  else if (body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
    const msg = body.entry[0].changes[0].value.messages[0];
    fromPhone = String(msg.from ?? "").replace(/\D/g, "").slice(-10);
    messageText = msg.text?.body ?? msg.type ?? "";
  }
  // Generic fallback
  else if (body.phone || body.mobile) {
    fromPhone = String(body.phone ?? body.mobile).replace(/\D/g, "").slice(-10);
    messageText = body.text ?? body.body ?? body.message ?? "";
  }

  req.log.info({ fromPhone, messageText }, "Inbound WhatsApp message");

  if (!fromPhone) {
    res.json({ received: true });
    return;
  }

  try {
    // Find the lead by phone
    const phoneVariants = [fromPhone, `+91${fromPhone}`, `91${fromPhone}`];
    let lead = null;
    for (const phone of phoneVariants) {
      const [found] = await db.select().from(leadsTable).where(eq(leadsTable.phone, phone));
      if (found) { lead = found; break; }
    }

    if (!lead) {
      res.json({ received: true });
      return;
    }

    // Find the most recent campaign recipient row for this lead (within 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [recipient] = await db
      .select()
      .from(campaignRecipientsTable)
      .where(
        and(
          eq(campaignRecipientsTable.leadId, lead.id),
          eq(campaignRecipientsTable.replied, false),
          gte(campaignRecipientsTable.sentAt, sevenDaysAgo)
        )
      )
      .orderBy(desc(campaignRecipientsTable.sentAt))
      .limit(1);

    if (recipient) {
      // Mark as replied with current lead state
      await db.update(campaignRecipientsTable)
        .set({
          replied: true,
          repliedAt: new Date(),
          leadStatusAfter: lead.status,
          leadScoreAfter: lead.score,
        })
        .where(eq(campaignRecipientsTable.id, recipient.id));

      // Increment campaign replied count
      await db
        .update(campaignsTable)
        .set({ repliedCount: db.$count(campaignRecipientsTable, and(
          eq(campaignRecipientsTable.campaignId, recipient.campaignId),
          eq(campaignRecipientsTable.replied, true)
        )) as unknown as number })
        .where(eq(campaignsTable.id, recipient.campaignId));

      // Simpler: just do a raw increment
      await db.execute(
        sql`UPDATE campaigns SET replied_count = replied_count + 1 WHERE id = ${recipient.campaignId}`
      );

      // Also undo the +1 from the $count attempt above to avoid double-count
      await db.execute(
        sql`UPDATE campaigns SET replied_count = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = ${recipient.campaignId} AND replied = true) WHERE id = ${recipient.campaignId}`
      );

      logger.info({ leadId: lead.id, campaignId: recipient.campaignId, messageText }, "Campaign reply recorded");
    }
  } catch (err) {
    logger.error({ err, fromPhone }, "Error processing WhatsApp inbound");
  }

  res.json({ received: true });
});

router.post("/webhooks/voice/stream", async (req, res): Promise<void> => {
  const { callSid, audioData, language } = req.body;

  if (!callSid || !audioData) {
    res.status(400).json({ error: "callSid and audioData required" });
    return;
  }

  const convo = conversations.get(callSid);
  if (!convo) {
    res.status(404).json({ error: "No active conversation for this callSid" });
    return;
  }

  try {
    // STT: convert audio to text
    const customerText = await speechToText(audioData, language || convo.language);
    if (!customerText) {
      res.json({ text: "", audioData: "", shouldTransfer: false, transferNumber: null });
      return;
    }

    // Detect language if first turn
    if (convo.history.length === 0) {
      const detectedLang = await detectLanguage(customerText);
      convo.language = detectedLang;
    }

    convo.transcript.push(`Customer: ${customerText}`);

    // Generate AI response
    const agentText = await generateAgentReply(
      customerText,
      convo.history,
      convo.leadName,
      convo.language
    );

    convo.history.push({ role: "user", content: customerText });
    convo.history.push({ role: "assistant", content: agentText });
    convo.transcript.push(`Agent: ${agentText}`);

    // TTS: convert response to audio
    const audioResponse = await textToSpeech(agentText, convo.language);

    // Check if hot lead needs transfer
    const recentText = customerText.toLowerCase();
    const hotSignals = ["buy now", "abhi lena", "ready", "confirm", "book karo", "de do", "finalise"];
    const shouldTransfer = hotSignals.some((s) => recentText.includes(s));

    const [callRecord] = await db.select().from(callsTable).where(eq(callsTable.exotelCallSid, callSid));
    let salesNumber: string | null = null;
    if (shouldTransfer && callRecord) {
      // Mark as hot
      await db.update(leadsTable)
        .set({ status: "hot", score: 90 })
        .where(eq(leadsTable.id, convo.leadId));
    }

    res.json({
      text: agentText,
      audioData: audioResponse,
      shouldTransfer,
      transferNumber: salesNumber,
    });

  } catch (err) {
    logger.error({ err, callSid }, "Voice stream error");
    res.status(500).json({ error: "Processing failed" });
  }
});

function mapExotelStatus(exotelStatus: string): string {
  const map: Record<string, string> = {
    completed: "completed",
    "no-answer": "missed",
    busy: "missed",
    failed: "failed",
    "in-progress": "in_progress",
    ringing: "ringing",
  };
  return map[exotelStatus?.toLowerCase()] ?? "completed";
}

export default router;
