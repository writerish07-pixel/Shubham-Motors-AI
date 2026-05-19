import { Router, type IRouter, type Request } from "express";
import { eq, desc, and, gte } from "drizzle-orm";
import { db, callsTable, leadsTable, followupsTable, campaignRecipientsTable, campaignsTable } from "@workspace/db";
import { generateAgentReply, analyzeCallIntent, learnFromTranscript } from "../lib/openai";
import { speechToText, detectLanguage } from "../lib/sarvam";
import { sendCallSummaryWhatsApp, sendBrochureWhatsApp } from "../lib/whatsapp";
import { knowledgeTable } from "@workspace/db";
import { logger } from "../lib/logger";
import axios from "axios";
import { sql } from "drizzle-orm";

const router: IRouter = Router();

// ── Helper: Exotel sends params as either query string (GET) or form body (POST)
function exoParams(req: Request): Record<string, string> {
  return { ...(req.query as Record<string, string>), ...(req.body ?? {}) };
}

// ── Helper: build ExoML XML response
function exoml(content: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${content}</Response>`;
}

// ── Helper: Say tag (Hindi by default, falls back to English)
function sayTag(text: string, language = "hi"): string {
  return `<Say voice="woman" language="${language}">${escapeXml(text)}</Say>`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Helper: Record tag that calls back our recording endpoint
function recordTag(callSid: string, host: string, maxLength = 20): string {
  const action = `${host}/api/webhooks/exotel/recording?callSid=${encodeURIComponent(callSid)}`;
  return `<Record action="${action}" method="POST" maxLength="${maxLength}" finishOnKey="#" playBeep="true" />`;
}

// ── In-memory conversation state (per callSid)
const conversations = new Map<string, {
  leadId: number;
  leadName: string;
  callRecordId: number | null;
  language: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  transcript: string[];
  turn: number;
}>();

// ── Helpers to get the public host
function getHost(req: Request): string {
  if (process.env.REPLIT_DEV_DOMAIN) return `https://${process.env.REPLIT_DEV_DOMAIN}`;
  const domains = process.env.REPLIT_DOMAINS?.split(",")[0];
  if (domains) return `https://${domains}`;
  return `${req.protocol}://${req.get("host")}`;
}

// ── INBOUND / OUTBOUND CONNECT webhook ───────────────────────────────────────
// Exotel POSTs (or GETs) here when the call connects.
// Must return ExoML XML so Exotel knows what to play/record.
router.all("/webhooks/exotel/inbound", async (req, res): Promise<void> => {
  const params = exoParams(req);
  const { CallSid, From, To, Direction } = params;

  req.log.info({ CallSid, From }, "Call connected — serving ExoML");

  if (!CallSid) {
    res.set("Content-Type", "text/xml").send(exoml(sayTag("क्षमा करें, एक त्रुटि हुई। कृपया बाद में कॉल करें।")));
    return;
  }

  // Find or create lead
  let lead = null;
  const fromPhone = From?.replace(/\D/g, "") ?? "";
  if (fromPhone) {
    const variants = [fromPhone, `+91${fromPhone.slice(-10)}`, fromPhone.slice(-10)];
    for (const phone of variants) {
      const [found] = await db.select().from(leadsTable).where(eq(leadsTable.phone, phone));
      if (found) { lead = found; break; }
    }
    if (!lead) {
      [lead] = await db.insert(leadsTable).values({
        name: fromPhone,
        phone: fromPhone.slice(-10),
        status: "new",
        score: 0,
        source: "inbound_call",
      }).returning();
    }
  }

  // Create or update call log
  let callRecordId: number | null = null;
  const existing = conversations.get(CallSid);
  if (existing) {
    callRecordId = existing.callRecordId;
  } else {
    const direction = Direction === "outbound" ? "outbound" : "inbound";
    // Check if there's already a call record from triggerOutbound
    const [existingCall] = await db.select().from(callsTable)
      .where(eq(callsTable.exotelCallSid, CallSid));
    if (existingCall) {
      callRecordId = existingCall.id;
      await db.update(callsTable).set({ status: "in_progress" }).where(eq(callsTable.id, existingCall.id));
    } else {
      const [newCall] = await db.insert(callsTable).values({
        leadId: lead?.id ?? 0,
        direction,
        status: "in_progress",
        exotelCallSid: CallSid,
      }).returning();
      callRecordId = newCall.id;
    }
  }

  // Init conversation state (still useful for /recording fallback path)
  const leadName = lead?.name ?? "आप";
  conversations.set(CallSid, {
    leadId: lead?.id ?? 0,
    leadName: leadName,
    callRecordId,
    language: lead?.language ?? "hi-IN",
    history: [],
    transcript: [],
    turn: 0,
  });

  // Build the WebSocket URL Exotel should stream audio to/from.
  // Prefer the published HTTPS domain (REPLIT_DOMAINS) — Exotel must reach a public
  // TLS endpoint. We convert https → wss and point at our Voicebot handler.
  const httpsHost = getHost(req);
  const wssUrl = httpsHost.replace(/^https?:\/\//, "wss://") + "/call/stream";

  // <Stream> ExoML — hands the live media stream to our Sarvam pipeline.
  // The custom parameters land on the `start` event so the WS knows who is calling.
  const streamXml =
    `<Stream url="${escapeXml(wssUrl)}">` +
      `<Parameter name="from" value="${escapeXml(From ?? "")}"/>` +
      `<Parameter name="call_sid" value="${escapeXml(CallSid)}"/>` +
      `<Parameter name="lead_name" value="${escapeXml(leadName)}"/>` +
    `</Stream>`;

  req.log.info({ CallSid, wssUrl }, "Returning <Stream> ExoML — Voicebot WS will take over");
  res.set("Content-Type", "text/xml").send(exoml(streamXml));
});

// ── RECORDING webhook — customer has spoken, we process and respond ──────────
router.all("/webhooks/exotel/recording", async (req, res): Promise<void> => {
  const params = exoParams(req);
  const callSid = (params.callSid ?? params.CallSid ?? "").toString();
  const recordingUrl = params.RecordingUrl ?? params.recordingUrl ?? "";
  const digits = params.Digits ?? "";

  req.log.info({ callSid, recordingUrl }, "Recording received");

  const convo = conversations.get(callSid);
  const host = getHost(req);

  // Customer hung up or too many turns
  if (!convo || convo.turn >= 6) {
    const bye = "धन्यवाद! हम जल्द ही आपसे संपर्क करेंगे। शुभम मोटर्स में कॉल के लिए शुक्रिया।";
    res.set("Content-Type", "text/xml").send(exoml(sayTag(bye)));
    return;
  }

  convo.turn++;

  try {
    let customerText = "";

    if (recordingUrl) {
      // Download the recording from Exotel
      try {
        const audioResp = await axios.get(recordingUrl, {
          responseType: "arraybuffer",
          auth: {
            username: process.env.EXOTEL_API_KEY ?? "",
            password: process.env.EXOTEL_API_TOKEN ?? "",
          },
          timeout: 10000,
        });
        // Pass raw Buffer — Sarvam requires multipart/form-data
        const audioBuf = Buffer.from(audioResp.data);
        customerText = await speechToText(audioBuf, convo.language);
        req.log.info({ callSid, customerText }, "STT result");
      } catch (sttErr) {
        req.log.warn({ sttErr }, "STT failed, using silence fallback");
        customerText = "";
      }
    }

    if (!customerText.trim()) {
      // No speech detected — prompt again
      const prompt = "मैंने आपकी आवाज़ नहीं सुनी। क्या आप फिर से बोल सकते हैं? # दबाकर समाप्त करें।";
      res.set("Content-Type", "text/xml").send(exoml(sayTag(prompt) + recordTag(callSid, host)));
      return;
    }

    convo.transcript.push(`Customer: ${customerText}`);

    // Detect language on first turn
    if (convo.turn === 1) {
      try {
        const detected = await detectLanguage(customerText);
        convo.language = detected;
      } catch { /* keep default */ }
    }

    // Generate AI response (English/Hindi fallback)
    const agentText = await generateAgentReply(customerText, convo.history, convo.leadName, convo.language);

    convo.history.push({ role: "user", content: customerText });
    convo.history.push({ role: "assistant", content: agentText });
    convo.transcript.push(`Agent: ${agentText}`);

    // Check for hot signal → early wrap-up
    const lower = customerText.toLowerCase();
    const hotSignals = ["buy", "book", "purchase", "lena hai", "chahiye", "confirm", "ready"];
    const isHot = hotSignals.some(s => lower.includes(s));

    if (isHot) {
      await db.update(leadsTable).set({ status: "hot", score: 90 }).where(eq(leadsTable.id, convo.leadId));
    }

    // Decide whether to continue or wrap up
    const isFinalTurn = convo.turn >= 5 || isHot;
    const xmlContent = isFinalTurn
      ? sayTag(agentText) + sayTag("धन्यवाद! हम जल्द ही आपसे संपर्क करेंगे। नमस्ते!")
      : sayTag(agentText) + recordTag(callSid, host);

    res.set("Content-Type", "text/xml").send(exoml(xmlContent));

  } catch (err) {
    req.log.error({ err, callSid }, "Recording processing error");
    const sorry = "क्षमा करें, एक तकनीकी समस्या आई। हम आपसे जल्द संपर्क करेंगे।";
    res.set("Content-Type", "text/xml").send(exoml(sayTag(sorry)));
  }
});

// ── STATUS webhook — call ended, run full analysis ───────────────────────────
router.all("/webhooks/exotel/status", async (req, res): Promise<void> => {
  const params = exoParams(req);
  const { CallSid, Status, Duration } = params;

  req.log.info({ CallSid, Status }, "Call status update");

  if (!CallSid) {
    res.json({ received: true });
    return;
  }

  const convo = conversations.get(CallSid);
  const [callRecord] = await db.select().from(callsTable).where(eq(callsTable.exotelCallSid, CallSid));

  if (!callRecord) {
    conversations.delete(CallSid);
    res.json({ received: true });
    return;
  }

  const dbStatus = mapExotelStatus(Status ?? "");
  const fullTranscript = convo?.transcript?.join("\n") ?? "";

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

      const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, callRecord.leadId));
      if (lead) {
        const sent = await sendCallSummaryWhatsApp(lead.phone, lead.name, analysis.summary, lead.interestedModel);
        if (sent) {
          await db.update(callsTable).set({ whatsappSent: true }).where(eq(callsTable.id, callRecord.id));
        }
        if (lead.interestedModel) {
          const [brochure] = await db.select().from(knowledgeTable).where(eq(knowledgeTable.category, "brochure"));
          if (brochure?.fileUrl) {
            await sendBrochureWhatsApp(lead.phone, lead.name, lead.interestedModel, brochure.fileUrl);
          }
        }
      }

      await learnFromTranscript(fullTranscript, analysis.summary);

    } catch (err) {
      req.log.error({ err, CallSid }, "Error processing call completion");
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
router.post("/webhooks/whatsapp/inbound", async (req, res): Promise<void> => {
  const body = req.body;
  let fromPhone: string | null = null;
  let messageText: string | null = null;

  if (body.from && body.message) {
    fromPhone = String(body.from).replace(/\D/g, "").slice(-10);
    messageText = typeof body.message === "string" ? body.message : body.message?.text ?? null;
  } else if (body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
    const msg = body.entry[0].changes[0].value.messages[0];
    fromPhone = String(msg.from ?? "").replace(/\D/g, "").slice(-10);
    messageText = msg.text?.body ?? msg.type ?? "";
  } else if (body.phone || body.mobile) {
    fromPhone = String(body.phone ?? body.mobile).replace(/\D/g, "").slice(-10);
    messageText = body.text ?? body.body ?? body.message ?? "";
  }

  req.log.info({ fromPhone, messageText }, "Inbound WhatsApp message");

  if (!fromPhone) {
    res.json({ received: true });
    return;
  }

  try {
    const phoneVariants = [fromPhone, `+91${fromPhone}`, `91${fromPhone}`];
    let lead = null;
    for (const phone of phoneVariants) {
      const [found] = await db.select().from(leadsTable).where(eq(leadsTable.phone, phone));
      if (found) { lead = found; break; }
    }
    if (!lead) { res.json({ received: true }); return; }

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [recipient] = await db
      .select()
      .from(campaignRecipientsTable)
      .where(and(
        eq(campaignRecipientsTable.leadId, lead.id),
        eq(campaignRecipientsTable.replied, false),
        gte(campaignRecipientsTable.sentAt, sevenDaysAgo)
      ))
      .orderBy(desc(campaignRecipientsTable.sentAt))
      .limit(1);

    if (recipient) {
      await db.update(campaignRecipientsTable)
        .set({ replied: true, repliedAt: new Date(), leadStatusAfter: lead.status, leadScoreAfter: lead.score })
        .where(eq(campaignRecipientsTable.id, recipient.id));

      await db.execute(
        sql`UPDATE campaigns SET replied_count = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = ${recipient.campaignId} AND replied = true) WHERE id = ${recipient.campaignId}`
      );

      logger.info({ leadId: lead.id, campaignId: recipient.campaignId }, "Campaign reply recorded");
    }
  } catch (err) {
    logger.error({ err, fromPhone }, "Error processing WhatsApp inbound");
  }

  res.json({ received: true });
});

// ── VOICE STREAM (legacy real-time endpoint) ──────────────────────────────────
router.post("/webhooks/voice/stream", async (req, res): Promise<void> => {
  const { callSid, audioData, language } = req.body ?? {};
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
    const audioBuf = Buffer.isBuffer(audioData) ? audioData : Buffer.from(audioData, "base64");
    const customerText = await speechToText(audioBuf, language || convo.language);
    if (!customerText) {
      res.json({ text: "", audioData: "", shouldTransfer: false, transferNumber: null });
      return;
    }
    if (convo.history.length === 0) {
      const detected = await detectLanguage(customerText);
      convo.language = detected;
    }
    convo.transcript.push(`Customer: ${customerText}`);
    const agentText = await generateAgentReply(customerText, convo.history, convo.leadName, convo.language);
    convo.history.push({ role: "user", content: customerText });
    convo.history.push({ role: "assistant", content: agentText });
    convo.transcript.push(`Agent: ${agentText}`);
    const lower = customerText.toLowerCase();
    const hotSignals = ["buy now", "abhi lena", "ready", "confirm", "book karo", "de do", "finalise"];
    const shouldTransfer = hotSignals.some((s) => lower.includes(s));
    if (shouldTransfer) {
      await db.update(leadsTable).set({ status: "hot", score: 90 }).where(eq(leadsTable.id, convo.leadId));
    }
    res.json({ text: agentText, audioData: "", shouldTransfer, transferNumber: null });
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
