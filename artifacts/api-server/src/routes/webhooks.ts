import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, callsTable, leadsTable, followupsTable } from "@workspace/db";
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
