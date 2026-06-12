/**
 * Exotel Voicebot WebSocket handler.
 * Exotel opens a WS connection to /call/stream when a call connects.
 * Audio: G.711 μ-law, 8 kHz, 8-bit, mono (20 ms chunks = 160 bytes each).
 *
 * FIXES vs original (June 2026 audit):
 *   1. Name extraction extended to turns 1–3 (was turn 1 only).
 *   2. Session now carries discoverySignals, convStage, emotionalTone.
 *   3. generateAgentReplyStream() receives all new params.
 *   4. handleStop() persists familyInfo, preferredModel, objections,
 *      competitorMentioned, competitorReason, buyingTimeline to DB.
 *   5. handleStop() uses computeFollowupDate() (smart server-side rules)
 *      instead of raw LLM-guessed date.
 *   6. Outbound context read from scheduler's getOutboundContext() map
 *      so Sakshi personalises the opening on auto-dialer calls.
 *   7. analyzeCallIntent() receives session.language for correct-language summaries.
 */

import type { IncomingMessage } from "http";
import type { Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { eq, desc } from "drizzle-orm";
import { db, callsTable, leadsTable, contactsTable } from "@workspace/db";
import { speechToText, textToSpeech, detectLanguage } from "./sarvam";
import { detectIntentWithMeta, getCachedPhrasePcm, warmPhraseCache, pickThinkingFiller } from "./voiceFastPath";
import { extractCustomerNameWithMeta } from "./nameExtractor";
import { detectRepeatRequest, buildRepeatInstruction } from "./conversationHelpers";
import { finalizeCompletedCall } from "./callFinalize";
import {
  generateAgentReplyStream,
  buildKnowledgeContext,
  getJaipurFuelPrice,
  extractDiscoverySignals,
  computeConvStage,
  detectEmotionalTone,
  type LeadProfile,
  type DiscoverySignals,
  type ConvStage,
  type EmotionalTone,
} from "./openai";
import { resample, buildWav, parseWav, rmsEnergy } from "./audioCodec";
import { transferCallToAgent } from "./exotel";
import { correctStt } from "./modelRouter";
import { getOutboundContext } from "./scheduler";  // FIX #6: outbound context
import { ensureSalesFollowUp } from "./salesFollowUp";
import { buildPurchaseVerificationGreeting, isFollowUpCall } from "./followUpCallContext";
import { buyingTimelineQuestion } from "./buyingTimeline";

function pcm16LeToS16(buf: Buffer): Int16Array {
  const n = buf.length >> 1;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}
function s16ToPcm16Le(samples: Int16Array): Buffer {
  const out = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(samples[i]!, i * 2);
  return out;
}
import { logger } from "./logger";

// ── Tuning constants ──────────────────────────────────────────────────────────
const SILENCE_RMS = 0.008;
const SILENCE_CHUNKS = 12;        // 240 ms silence → trigger STT
const MIN_SPEECH_CHUNKS = 8;      // 160 ms min speech
const MAX_SPEECH_CHUNKS = 600;    // 12 s max before forced trigger
const STT_SAMPLE_RATE = 16000;
const EXOTEL_SAMPLE_RATE = 8000;
const CHUNK_BYTES = 320;          // 20 ms @ 8 kHz × 2 bytes/sample

// ── Barge-in / echo-guard ──────────────────────────────────────────────────────
const BARGE_IN_RMS = SILENCE_RMS * 12;   // 0.096
const BARGE_IN_FRAMES = 10;
const BARGE_IN_GRACE_MS = 400;

// ── Per-call session ──────────────────────────────────────────────────────────
interface Session {
  callSid: string;
  streamSid: string;
  leadId: number;
  leadName: string;
  callDbId: number | null;
  language: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  transcript: string[];
  turn: number;
  audioBuf: Buffer[];
  silenceCount: number;
  speechCount: number;
  isProcessing: boolean;
  isClosed: boolean;
  isSpeaking?: boolean;
  ttsAbort?: boolean;
  bargeInCount?: number;
  speakingStartedAt?: number;
  ttsGen: number;
  leadProfile?: LeadProfile;

  // ── NEW: sales intelligence fields ────────────────────────────────────────
  /** Discovery signals extracted server-side each turn */
  discoverySignals: DiscoverySignals;
  /** Current conversation stage — recomputed each turn */
  convStage: ConvStage;
  /** Emotional tone detected from last customer utterance */
  emotionalTone: EmotionalTone;
  /** Whether this is an outbound (auto-dialer) call */
  isOutbound: boolean;
  /** A NEW question the customer asked mid-answer (topic interrupt) — the LLM
   *  is told to answer it first. Cleared after each LLM turn. */
  pendingQuestion: string | null;
  /** Name heard from STT may be wrong — confirm once with customer. */
  nameNeedsConfirmation: boolean;
  nameConfirmed: boolean;

  // ── PROACTIVE SALES ENGINE ──────────────────────────────────────────────────
  /** Timer that fires when customer is silent — agent proactively speaks */
  proactiveTimer: ReturnType<typeof setTimeout> | null;
  /** Number of proactive nudges fired this call (capped at 4) */
  proactiveCount: number;
  /** Timestamp of last agent speech — prevents nudge firing during TTS */
  lastAgentSpokeAt: number;
}

// ── WebSocket server ─────────────────────────────────────────────────────────
export function setupVoicebotWS(httpServer: Server): void {
  const wss = new WebSocketServer({ server: httpServer, path: "/call/stream" });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
    let session: Session | null = null;

    ws.on("message", async (raw: Buffer | string) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      try {
        switch (msg.event) {
          case "connected":
            logger.info("Voicebot WS connected");
            break;
          case "start":
            logger.info({ raw: JSON.stringify(msg).slice(0, 1000) }, "Raw start event");
            session = await handleStart(ws, msg);
            break;
          case "media":
            if (session && !session.isClosed) await handleMedia(ws, session, msg);
            break;
          case "stop":
            if (session && !session.isClosed) {
              session.isClosed = true;
              await handleStop(session);
              session = null;
            }
            break;
        }
      } catch (err) {
        logger.error({ err, event: msg.event }, "Voicebot WS handler error");
      }
    });

    ws.on("close", async () => {
      if (session && !session.isClosed) {
        session.isClosed = true;
        await handleStop(session).catch((e) => logger.error({ e }, "Error in WS close handler"));
      }
    });

    ws.on("error", (err) => logger.error({ err }, "Voicebot WS error"));
  });

  logger.info("Voicebot WebSocket server ready at /call/stream");
}

// ── handleStart ───────────────────────────────────────────────────────────────
async function handleStart(ws: WebSocket, msg: Record<string, unknown>): Promise<Session> {
  const start = (msg.start ?? {}) as Record<string, unknown>;
  const callSid = String(start.callSid ?? start.call_sid ?? msg.callSid ?? msg.call_sid ?? "");
  const streamSid = String(start.streamSid ?? start.stream_sid ?? msg.streamSid ?? msg.stream_sid ?? "");
  const customParams = (start.customParameters ?? start.custom_parameters ?? {}) as Record<string, string>;
  const fromPhone = String(customParams.from ?? customParams.From ?? (start.from as string) ?? "");
  // Detect outbound: Exotel passes direction in customParameters
  const direction = String(customParams.direction ?? customParams.Direction ?? "inbound").toLowerCase();
  const isOutbound = direction === "outbound";

  logger.info({ callSid, streamSid, isOutbound }, "Call stream started");

  // Find or create lead
  let lead = null;
  if (fromPhone) {
    const digits = fromPhone.replace(/\D/g, "").slice(-10);
    for (const phone of [digits, `+91${digits}`, `91${digits}`]) {
      const [found] = await db.select().from(leadsTable).where(eq(leadsTable.phone, phone));
      if (found) { lead = found; break; }
    }
    if (!lead && digits) {
      [lead] = await db.insert(leadsTable).values({
        name: "", phone: digits, status: "new", score: 0, source: isOutbound ? "outbound_call" : "inbound_call",
      }).returning();
    }
  }

  // Upsert call record
  let callDbId: number | null = null;
  const [existing] = await db.select().from(callsTable).where(eq(callsTable.exotelCallSid, callSid));
  if (existing) {
    callDbId = existing.id;
    await db.update(callsTable).set({ status: "in_progress" }).where(eq(callsTable.id, existing.id));
  } else if (lead) {
    const [newCall] = await db.insert(callsTable).values({
      leadId: lead.id, direction: isOutbound ? "outbound" : "inbound",
      status: "in_progress", exotelCallSid: callSid,
    }).returning();
    callDbId = newCall.id;
  }

  // FIX #6: Read outbound context if this is an auto-dialer call.
  // Scheduler sets this in getOutboundContext(phone) before placing the call.
  const outboundCtx = isOutbound && fromPhone
    ? getOutboundContext(fromPhone.replace(/\D/g, "").slice(-10))
    : null;

  let priorCompletedCalls = 0;
  let lastTranscriptSnippet: string | null = null;
  if (lead) {
    const priorCalls = await db
      .select({ id: callsTable.id, status: callsTable.status, transcript: callsTable.transcript })
      .from(callsTable)
      .where(eq(callsTable.leadId, lead.id))
      .orderBy(desc(callsTable.createdAt))
      .limit(5);
    priorCompletedCalls = priorCalls.filter((c) => c.status === "completed").length;
    const lastWithTx = priorCalls.find((c) => c.transcript && c.transcript.length > 20);
    if (lastWithTx?.transcript) lastTranscriptSnippet = lastWithTx.transcript.slice(-400);
  }

  const followUpCall = isFollowUpCall(priorCompletedCalls, isOutbound);

  // Build leadProfile — merge DB data with outbound context (outbound context wins
  // because it was set just seconds ago by the scheduler with fresh DB data).
  const baseProfile: LeadProfile | undefined = lead ? {
    name: lead.name || undefined,
    interestedModel: lead.interestedModel ?? null,
    notes: lead.notes ?? null,
    lastCallSummary: lead.intentSummary ?? null,
    status: lead.status ?? null,
    buyingTimeline: lead.buyingTimeline ?? null,
    priorCallCount: priorCompletedCalls,
    lastTranscriptSnippet,
    isFollowUpCall: followUpCall,
    isOutbound,
    decisionMaker: (lead.decisionMaker === "self" || lead.decisionMaker === "family" || lead.decisionMaker === "joint")
      ? lead.decisionMaker
      : null,
  } : undefined;

  const leadProfile: LeadProfile | undefined = outboundCtx ? {
    name: outboundCtx.name || baseProfile?.name,
    interestedModel: outboundCtx.interestedModel ?? baseProfile?.interestedModel,
    notes: outboundCtx.notes ?? baseProfile?.notes,
    lastCallSummary: outboundCtx.lastCallSummary ?? baseProfile?.lastCallSummary,
    status: baseProfile?.status,
    buyingTimeline: baseProfile?.buyingTimeline,
    priorCallCount: priorCompletedCalls,
    lastTranscriptSnippet,
    isFollowUpCall: followUpCall,
    isOutbound,
    followupReason: outboundCtx.followupReason ?? null,
    decisionMaker: baseProfile?.decisionMaker,
  } : baseProfile;

  const leadName = (leadProfile?.name && leadProfile.name.trim() && !leadProfile.name.startsWith("Lead "))
    ? leadProfile.name
    : "Sir";

  // Seed discovery signals from prior calls so the agent never re-asks what it
  // already knows (segment → km → budget → current vehicle carry forward).
  const priorSignals: DiscoverySignals = {};
  if (lead) {
    if (lead.segment) priorSignals.segment = lead.segment as DiscoverySignals["segment"];
    if (lead.dailyKm) priorSignals.km = lead.dailyKm;
    if (lead.budget) priorSignals.budget = lead.budget;
    if (lead.currentVehicle) priorSignals.currentVehicle = lead.currentVehicle;
    if (lead.decisionMaker === "self" || lead.decisionMaker === "family" || lead.decisionMaker === "joint") {
      priorSignals.decisionMaker = lead.decisionMaker;
    }
    if (lead.buyingTimeline && /^(immediate|15days|month|festival|loan_closure|next_year)$/.test(lead.buyingTimeline)) {
      priorSignals.buyingTimeline = lead.buyingTimeline as DiscoverySignals["buyingTimeline"];
    }
  }

  const session: Session = {
    callSid, streamSid,
    leadId: lead?.id ?? 0,
    leadName,
    callDbId,
    language: lead?.language ?? "hi-IN",
    history: [],
    transcript: [],
    turn: 0,
    audioBuf: [],
    silenceCount: 0,
    speechCount: 0,
    isProcessing: false,
    isClosed: false,
    ttsGen: 0,
    leadProfile,
    isOutbound,
    // NEW: initialise sales intelligence (seeded from prior-call CRM data)
    discoverySignals: priorSignals,
    convStage: "connect",
    emotionalTone: "neutral",
    pendingQuestion: null,
    nameNeedsConfirmation: false,
    nameConfirmed: false,
    proactiveTimer: null,
    proactiveCount: 0,
    lastAgentSpokeAt: Date.now(),
  };

  // Greeting — follow-up calls ask purchase outcome first (reference agent.py)
  let greeting: string;
  if (followUpCall && (isOutbound || priorCompletedCalls >= 1)) {
    greeting = buildPurchaseVerificationGreeting(
      leadName,
      outboundCtx?.interestedModel ?? leadProfile?.interestedModel,
      outboundCtx?.followupReason,
    );
  } else if (isOutbound && outboundCtx?.followupReason) {
    const addrName = leadName === "Sir" ? "" : `${leadName} जी`;
    greeting = `नमस्ते ${addrName}! मैं साक्षी बोल रही हूँ, शुभम मोटर्स से। ${outboundCtx.followupReason} — क्या अभी 2 minute baat kar sakte hain?`;
  } else if (leadName !== "Sir") {
    greeting = `नमस्ते ${leadName} जी! मैं साक्षी बोल रही हूँ, शुभम मोटर्स से। बताइए, मैं आपकी क्या help कर सकती हूँ?`;
  } else {
    greeting = `नमस्ते! मैं साक्षी बोल रही हूँ, शुभम मोटर्स से — Hero MotoCorp के अधिकृत डीलर। पहले आपका शुभ नाम जान सकती हूँ?`;
  }

  // DPDP recording notice — short, confident, mid-greeting (research: a legalistic
  // preamble kills conversion; a brief notice does not). Disable with RECORDING_NOTICE=0.
  if (RECORDING_NOTICE_ENABLED) greeting += ` ${RECORDING_NOTICE}`;

  session.transcript.push(`Agent: ${greeting}`);
  session.history.push({ role: "assistant", content: greeting });
  session.lastAgentSpokeAt = Date.now();
  // PROACTIVE: if customer doesn't respond within 8s of greeting, Sakshi speaks first
  scheduleProactiveNudge(ws, session, 6000);

  const cachedPcm = GREETING_CACHE.get(greeting);
  if (cachedPcm) {
    session.isSpeaking = true;
    session.ttsAbort = false;
    session.bargeInCount = 0;
    session.speakingStartedAt = Date.now();
    void playPcm8k(ws, session.streamSid, cachedPcm, session)
      .catch(() => {})
      .finally(() => {
        session.isSpeaking = false;
        session.ttsAbort = false;
        session.bargeInCount = 0;
        session.speakingStartedAt = undefined;
      });
  } else {
    void streamTtsToWs(ws, session.streamSid, greeting, session.language, session).catch(() => {});
  }

  void Promise.all([buildKnowledgeContext(), getJaipurFuelPrice()]).catch(() => {});
  return session;
}

// ── Greeting cache ────────────────────────────────────────────────────────────
const GREETING_CACHE = new Map<string, Int16Array>();
const RECORDING_NOTICE = "Yeh call quality ke liye record hoti hai.";
const RECORDING_NOTICE_ENABLED = process.env.RECORDING_NOTICE !== "0";
const UNKNOWN_GREETING_BASE = `नमस्ते! मैं साक्षी बोल रही हूँ, शुभम मोटर्स से — Hero MotoCorp के अधिकृत डीलर। पहले आपका शुभ नाम जान सकती हूँ?`;
const UNKNOWN_GREETING = RECORDING_NOTICE_ENABLED
  ? `${UNKNOWN_GREETING_BASE} ${RECORDING_NOTICE}`
  : UNKNOWN_GREETING_BASE;

async function warmGreetingCache(): Promise<void> {
  try {
    const pcm = await synthesizeTts(UNKNOWN_GREETING, "hi-IN");
    if (pcm) { GREETING_CACHE.set(UNKNOWN_GREETING, pcm); logger.info({ samples: pcm.length }, "Greeting TTS pre-cached"); }
  } catch (err) { logger.warn({ err }, "Greeting pre-cache failed (non-fatal)"); }
}
void warmGreetingCache();
void warmPhraseCache((text) => synthesizeTts(text, "hi-IN"));

// ── handleMedia ───────────────────────────────────────────────────────────────
async function handleMedia(ws: WebSocket, session: Session, msg: Record<string, unknown>): Promise<void> {
  const media = (msg.media ?? {}) as Record<string, unknown>;
  const payload = String(media.payload ?? "");
  if (!payload) return;

  const chunk = Buffer.from(payload, "base64");
  const pcm = pcm16LeToS16(chunk);
  const energy = rmsEnergy(pcm);

  // ── Barge-in with echo guard ──────────────────────────────────────────────
  if (session.isSpeaking) {
    if (session.ttsAbort) {
      session.isSpeaking = false;
      // fall through
    } else {
      const startedAt = session.speakingStartedAt ?? 0;
      if (startedAt && Date.now() - startedAt < BARGE_IN_GRACE_MS) return;

      if (energy > BARGE_IN_RMS) {
        session.bargeInCount = (session.bargeInCount ?? 0) + 1;
        if (session.bargeInCount >= BARGE_IN_FRAMES) {
          session.ttsAbort = true;
          session.ttsGen++;
          session.isSpeaking = false;
          logger.info({ callSid: session.callSid, energy }, "Barge-in confirmed — stopping TTS");
          try { ws.send(JSON.stringify({ event: "clear", stream_sid: session.streamSid, streamSid: session.streamSid })); } catch { /* ws closed */ }
          session.bargeInCount = 0;
          // fall through — buffer this frame
        } else { return; }
      } else {
        session.bargeInCount = 0;
        return;
      }
    }
  }

  if (energy > SILENCE_RMS) {
    if (session.speechCount === 0) cancelProactiveTimer(session); // speech onset — never nudge over the customer
    session.speechCount++;
    session.silenceCount = 0;
    session.audioBuf.push(chunk);
  } else {
    session.silenceCount++;
    if (session.speechCount > 0) session.audioBuf.push(chunk);
  }

  const totalChunks = session.audioBuf.length;
  const shouldProcess =
    !session.isProcessing &&
    session.speechCount >= MIN_SPEECH_CHUNKS &&
    (session.silenceCount >= SILENCE_CHUNKS || totalChunks >= MAX_SPEECH_CHUNKS);

  if (shouldProcess) {
    const buffered = session.audioBuf.splice(0);
    session.speechCount = 0;
    session.silenceCount = 0;
    session.isProcessing = true;
    runPipeline(ws, session, buffered)
      .catch((err) => logger.error({ err, callSid: session.callSid }, "Pipeline error"))
      .finally(() => { session.isProcessing = false; });
  }
}

// ── handleStop ────────────────────────────────────────────────────────────────
async function handleStop(session: Session): Promise<void> {
  cancelProactiveTimer(session);
  logger.info({ callSid: session.callSid }, "Call stream stopped — analysing");
  session.ttsAbort = true;
  session.isSpeaking = false;
  session.ttsGen++;

  const transcript = session.transcript.join("\n");
  if (!transcript.trim()) return;

  try {
    let callDbId = session.callDbId;
    if (!callDbId && session.leadId) {
      const [newCall] = await db.insert(callsTable).values({
        leadId: session.leadId,
        direction: session.isOutbound ? "outbound" : "inbound",
        status: "completed",
        exotelCallSid: session.callSid,
        transcript,
      }).returning();
      callDbId = newCall?.id ?? null;
    }
    if (!callDbId || !session.leadId) {
      logger.warn({ callSid: session.callSid, leadId: session.leadId }, "Call finalise skipped — no call/lead row");
      return;
    }

    await finalizeCompletedCall({
      callDbId,
      leadId: session.leadId,
      transcript,
      sessionLanguage: session.language,
      discoverySignals: session.discoverySignals,
      exotelCallSid: session.callSid,
    });
  } catch (err) {
    logger.error({ err, callSid: session.callSid }, "Error finalising call");
  }
}

// ── runPipeline ───────────────────────────────────────────────────────────────
async function runPipeline(ws: WebSocket, session: Session, chunks: Buffer[]): Promise<void> {
  cancelProactiveTimer(session); // customer is speaking — cancel any pending nudge
  if (ws.readyState !== WebSocket.OPEN) return;
  if (session.isClosed) return;

  const raw = Buffer.concat(chunks);
  const pcm8k = pcm16LeToS16(raw);
  const pcm16k = resample(pcm8k, EXOTEL_SAMPLE_RATE, STT_SAMPLE_RATE);
  const wavBuf = buildWav(pcm16k, STT_SAMPLE_RATE);

  let customerText = await speechToText(wavBuf, session.language);
  if (!customerText?.trim()) return;

  logger.info({ callSid: session.callSid, customerText }, "STT result");
  session.transcript.push(`Customer: ${customerText}`);

  // Language detection on first turn
  if (session.turn === 0) {
    void detectLanguage(customerText)
      .then((lang) => { session.language = lang; })
      .catch(() => { /* keep hi-IN */ });
  }
  session.turn++;

  const correctedText = correctStt(customerText);

  // Name capture turns 1–3; confirm if STT may have misheard (e.g. Gyan → Jan).
  if (session.turn <= 3 && (session.leadName === "Sir" || session.nameNeedsConfirmation)) {
    const { name, needsConfirmation } = extractCustomerNameWithMeta(customerText);
    if (name) {
      session.leadName = name;
      session.nameNeedsConfirmation = needsConfirmation && !session.nameConfirmed;
      if (session.leadId) {
        await db.update(leadsTable).set({ name }).where(eq(leadsTable.id, session.leadId));
      }
      logger.info({ callSid: session.callSid, name, needsConfirmation, turn: session.turn }, "Captured customer name");
    }
    if (/sahi hai|sahee hai|han sahi|हाँ सही|correct|theek hai naam/i.test(correctedText) && session.leadName !== "Sir") {
      session.nameConfirmed = true;
      session.nameNeedsConfirmation = false;
    }
    if (/nahi|galat|wrong|नहीं|गलत/i.test(correctedText) && /naam|name/i.test(correctedText)) {
      session.leadName = "Sir";
      session.nameNeedsConfirmation = true;
      session.nameConfirmed = false;
    }
  }

  // Turn limit — raise to 30 for hot leads
  const maxTurns = session.discoverySignals && Object.keys(session.discoverySignals).length > 0 ? 30 : 25;
  if (session.turn > maxTurns) {
    logger.info({ callSid: session.callSid, turn: session.turn }, "Turn limit reached → transfer to sales");
    await runTransfer(ws, session, "[TRANSFER] turn limit reached — long conversation, hand to sales");
    return;
  }

  // Customer-requested transfer safety net
  if (isCustomerAskingForHuman(correctedText)) {
    session.history.push({ role: "user", content: customerText });
    if (session.history.length > 12) session.history.splice(0, session.history.length - 12);
    const tag = "[TRANSFER] customer explicitly asked to speak with a sales person";
    session.history.push({ role: "assistant", content: tag });
    session.transcript.push(`Agent[tag]: ${tag}`);
    await runTransfer(ws, session, tag);
    return;
  }

  // TRAI/DND: explicit opt-out — honor instantly and permanently. The agent's
  // not_interested fast-path says the goodbye; this flag stops all future dials.
  if (isExplicitOptOut(correctedText) && session.leadId) {
    await db.update(leadsTable).set({ doNotCall: true, status: "not_interested" }).where(eq(leadsTable.id, session.leadId));
    logger.info({ callSid: session.callSid, leadId: session.leadId }, "Customer opted out — doNotCall set");
  }

  // FIX #2: Update discovery signals, stage, and tone each turn
  session.discoverySignals = extractDiscoverySignals(correctedText, session.discoverySignals);
  session.convStage = computeConvStage(session.turn, session.discoverySignals, correctedText);
  session.emotionalTone = detectEmotionalTone(correctedText, session.turn);

  let repeatInstruction = "";
  if (detectRepeatRequest(correctedText)) {
    repeatInstruction = buildRepeatInstruction(session.history);
    logger.info({ callSid: session.callSid }, "Repeat request detected");
  }

  const fastMeta = detectIntentWithMeta(correctedText, session.turn, { signals: session.discoverySignals });
  const fastReply = fastMeta?.response ?? null;
  // Skip fast-path when customer wants a repeat — LLM/direct router handles context.
  if (fastReply && !repeatInstruction) {
    // Terminal/exit intents must NOT get a sales question appended — the customer
    // just said busy/not-interested/thanks; pushing "scooter ya bike?" here is
    // tone-deaf and kills trust.
    const TERMINAL_FAST_INTENTS = new Set(["busy", "not_interested", "callback", "thanks"]);
    const fastWithFollowUp = TERMINAL_FAST_INTENTS.has(fastMeta?.name ?? "")
      ? fastReply
      : ensureSalesFollowUp(fastReply, {
          signals: session.discoverySignals,
          convStage: session.convStage,
          turn: session.turn,
          customerText: correctedText,
          leadName: session.leadName,
        });
    session.history.push({ role: "user", content: customerText });
    if (session.history.length > 12) session.history.splice(0, session.history.length - 12);
    session.isSpeaking = true;
    session.ttsAbort = false;
    session.bargeInCount = 0;
    session.speakingStartedAt = Date.now();
    const myGen = ++session.ttsGen;
    let actuallyPlayed = false;
    try {
      const pcm = await synthesizeTts(fastWithFollowUp, session.language);
      if (pcm && !session.ttsAbort && !session.isClosed && session.ttsGen === myGen && ws.readyState === WebSocket.OPEN) {
        await playPcm8k(ws, session.streamSid, pcm, session);
        if (!session.ttsAbort && session.ttsGen === myGen) actuallyPlayed = true;
      }
    } finally {
      session.isSpeaking = false;
      session.ttsAbort = false;
      session.bargeInCount = 0;
      session.speakingStartedAt = undefined;
    }
    if (actuallyPlayed) {
      session.history.push({ role: "assistant", content: fastWithFollowUp });
      session.transcript.push(`Agent: ${fastWithFollowUp}`);
      session.lastAgentSpokeAt = Date.now();
      scheduleProactiveNudge(ws, session, 4500);
    }
    logger.info({ callSid: session.callSid, intent: fastMeta?.name, agentText: actuallyPlayed ? fastWithFollowUp : "", played: actuallyPlayed ? 1 : 0, source: "fastpath" }, "Agent reply");
    return;
  }

  // ── TOPIC INTERRUPT DETECTION ──────────────────────────────────────────────
  // If the agent was talking about topic A and the customer suddenly asks about
  // topic B, capture the new question so the LLM answers it FIRST this turn.
  const lastAgentTurn = session.history.filter(h => h.role === "assistant").slice(-1)[0]?.content ?? "";
  if (session.turn > 1 && detectTopicShift(lastAgentTurn, correctedText)) {
    session.pendingQuestion = correctedText;
    logger.info({ callSid: session.callSid, pendingQ: correctedText.slice(0, 60) }, "Topic interrupt detected");
  }
  const currentPendingQ = session.pendingQuestion;
  session.pendingQuestion = null;

  // FIX #3: Pass discoverySignals, convStage, emotionalTone to LLM
  session.history.push({ role: "user", content: customerText });
  if (session.history.length > 12) session.history.splice(0, session.history.length - 12);

  session.isSpeaking = true;
  session.ttsAbort = false;
  session.bargeInCount = 0;
  session.speakingStartedAt = Date.now();
  const myGen = ++session.ttsGen;

  // Conditional thinking filler — only if first sentence takes >900ms (reduced, not every turn).
  const FILLER_DELAY_MS = 900;
  const fillerText = pickThinkingFiller(correctedText, session.turn);
  let firstSentenceReady = false;
  const fillerDone: Promise<void> = fillerText
    ? (async () => {
        await new Promise((r) => setTimeout(r, FILLER_DELAY_MS));
        if (firstSentenceReady || session.ttsAbort || session.isClosed || session.ttsGen !== myGen || ws.readyState !== WebSocket.OPEN) return;
        const pcm = getCachedPhrasePcm(fillerText, session.language) ?? await synthesizeTts(fillerText, session.language);
        if (firstSentenceReady || !pcm || session.ttsAbort || session.isClosed || session.ttsGen !== myGen || ws.readyState !== WebSocket.OPEN) return;
        await playPcm8k(ws, session.streamSid, pcm, session);
      })().catch(() => {})
    : Promise.resolve();

  const played: string[] = [];
  let playChain: Promise<void> = fillerDone;
  let transferText: string | null = null;
  let attemptedCount = 0;
  let ttsFailures = 0;
  const MAX_REPLY_SENTENCES = 3;

  try {
    for await (const sentence of generateAgentReplyStream(
      correctedText,
      session.history,
      session.leadName,
      session.language,
      session.leadProfile,
      session.discoverySignals,   // NEW
      session.convStage,           // NEW
      session.emotionalTone,       // NEW
      currentPendingQ ?? undefined, // NEW: topic interrupt
      repeatInstruction || undefined,
      session.nameNeedsConfirmation && !session.nameConfirmed,
    )) {
      if (session.ttsAbort || session.isClosed) break;
      if (/^\s*\[TRANSFER/i.test(sentence)) { transferText = sentence; break; }
      attemptedCount++;
      const isFirstSentence = attemptedCount === 1;
      const myTts = synthesizeTts(sentence, session.language);
      const prev = playChain;
      playChain = (async () => {
        const pcm = await myTts;
        if (isFirstSentence) firstSentenceReady = true;
        await prev;
        if (!pcm) { ttsFailures++; return; }
        if (session.ttsAbort || session.isClosed || session.ttsGen !== myGen || ws.readyState !== WebSocket.OPEN) return;
        await playPcm8k(ws, session.streamSid, pcm, session);
        if (!session.ttsAbort && session.ttsGen === myGen) played.push(sentence);
      })();
      if (attemptedCount >= MAX_REPLY_SENTENCES) break;
    }
    if (!session.ttsAbort && !session.isClosed) await playChain;
  } finally {
    session.isSpeaking = false;
    session.ttsAbort = false;
    session.bargeInCount = 0;
    session.speakingStartedAt = undefined;
  }

  const spoken = played.join(" ").trim();
  const agentText = transferText ?? spoken;
  if (spoken) {
    session.history.push({ role: "assistant", content: spoken });
    session.transcript.push(`Agent: ${spoken}`);
  }
  if (transferText) {
    session.history.push({ role: "assistant", content: transferText });
    session.transcript.push(`Agent[tag]: ${transferText}`);
  }
  logger.info({ callSid: session.callSid, agentText, attempted: attemptedCount, played: played.length, ttsFailures, transfer: !!transferText }, "Agent reply");

  if (/^\s*\[TRANSFER/i.test(agentText)) {
    await runTransfer(ws, session, agentText);
    return;
  }

  // PROACTIVE: re-arm — if customer is silent ~4.5s after agent finishes, Sakshi continues
  session.lastAgentSpokeAt = Date.now();
  scheduleProactiveNudge(ws, session, 4500);

  // Hot-lead detection
  const lower = customerText.toLowerCase();
  if (["buy", "book", "lena hai", "chahiye", "confirm", "ready", "le lunga"].some(s => lower.includes(s))) {
    await db.update(leadsTable).set({ status: "hot", score: 90 }).where(eq(leadsTable.id, session.leadId));
  }
}

// ── PROACTIVE SALES ENGINE ───────────────────────────────────────────────────
// Core fix for the "reactive bot" problem. A real salesperson never sits
// silent — they fill silence with discovery questions, pitches, and closes.
//
//   • After greeting          → scheduleProactiveNudge(8s)
//   • After every agent reply  → scheduleProactiveNudge(6s)
//   • Customer speaks          → cancelProactiveTimer()
//   • Timer fires              → getProactiveMessage() picks the smartest line
//     based on what we still don't know (segment → km → family → budget),
//     then pitches/closes once enough is known.
// ─────────────────────────────────────────────────────────────────────────────

function cancelProactiveTimer(session: Session): void {
  if (session.proactiveTimer) {
    clearTimeout(session.proactiveTimer);
    session.proactiveTimer = null;
  }
}

function scheduleProactiveNudge(ws: WebSocket, session: Session, delayMs: number): void {
  cancelProactiveTimer(session);
  if (session.isClosed || session.proactiveCount >= 4) return;

  session.proactiveTimer = setTimeout(async () => {
    session.proactiveTimer = null;
    if (session.isClosed || session.isSpeaking || session.isProcessing) return;
    if (session.speechCount > 0) return; // customer is mid-utterance — do not talk over them
    if (Date.now() - session.lastAgentSpokeAt < 2000) return; // TTS may still be playing

    let msg = getProactiveMessage(session);
    if (!msg) return;
    msg = ensureSalesFollowUp(msg, {
      signals: session.discoverySignals,
      convStage: session.convStage,
      turn: session.turn,
      leadName: session.leadName,
    });

    session.proactiveCount++;
    logger.info({ callSid: session.callSid, count: session.proactiveCount, msg: msg.slice(0, 60) }, "Proactive nudge");

    session.isSpeaking = true;
    session.ttsAbort = false;
    session.speakingStartedAt = Date.now();
    const myGen = ++session.ttsGen;
    try {
      const pcm = await synthesizeTts(msg, session.language);
      if (!pcm || session.ttsAbort || session.isClosed || session.ttsGen !== myGen || ws.readyState !== WebSocket.OPEN) return;
      await playPcm8k(ws, session.streamSid, pcm, session);
      if (!session.ttsAbort && session.ttsGen === myGen) {
        session.history.push({ role: "assistant", content: msg });
        session.transcript.push(`Agent[proactive]: ${msg}`);
        session.lastAgentSpokeAt = Date.now();
        scheduleProactiveNudge(ws, session, 6000); // nudge again in 8s if still silent
      }
    } catch (err) {
      logger.error({ err }, "Proactive nudge TTS failed");
    } finally {
      session.isSpeaking = false;
      session.ttsAbort = false;
      session.speakingStartedAt = undefined;
    }
  }, delayMs);
}

// Picks the most valuable proactive line. Priority: segment → km → family →
// budget → current vehicle → segment-specific pitch → close.
function getProactiveMessage(session: Session): string | null {
  const s = session.discoverySignals;
  const name = session.leadName !== "Sir" && session.turn % 4 === 0 ? `${session.leadName} ji, ` : "";
  const turn = session.turn;
  const count = session.proactiveCount;

  // Customer hasn't said anything yet
  if (turn <= 1) {
    return `${name}aap sun pa rahe hain? Main Shubham Motors se Sakshi bol rahi hoon — koi bhi Hero bike ya scooter ke baare mein batayein.`;
  }

  // ── DISCOVERY — segment FIRST (cannot recommend without it) ────────────────
  if (!s.segment && count <= 2) {
    return `${name}, ek quick sawaal — scooter dekh rahe hain ya bike? Aur roughly kitne CC ka — 100cc, 125cc, ya kuch aur? Isse main exact best model bata sakti hoon.`;
  }
  if (!s.km && count <= 3) {
    return `${name}, daily roughly kitne km chalate hain? Isse pata chalta hai kaunsa model sabse zyada fuel-efficient rahega aapke liye.`;
  }
  if (s.segment?.startsWith("scooter") && s.familyUse === undefined && count <= 3) {
    return `${name}, scooter sirf aap chalenge ya family ke liye bhi? Wife ya bachche baithein toh seat size aur comfort matter karta hai.`;
  }
  if (s.familyUse && !s.decisionMaker && count <= 3) {
    return `${name}, purchase ka decision aap khud lenge ya family ke saath mil kar? Isse main sahi finance aur model suggest kar sakti hoon.`;
  }
  if (!s.budget && count <= 4) {
    return `${name}, roughly kitna budget soch rahe hain? EMI mein lena ho toh ₹3,000 mahine se shuru hota hai — Hero FinCorp 30 minute mein approve karta hai.`;
  }
  if (!s.currentVehicle && count <= 4) {
    return `${name}, abhi kya chala rahe hain? Purani vehicle ho toh exchange mein ₹10,000-20,000 tak mil jaata hai.`;
  }
  if (!s.buyingTimeline && count <= 4 && (s.segment || s.interestedModel)) {
    return `${name}, ${buyingTimelineQuestion(s.interestedModel)}`;
  }

  // ── SEGMENT-SPECIFIC PITCH ─────────────────────────────────────────────────
  const fuel = (km: number, kmpl: number) => Math.round((km * 30 / kmpl) * 108).toLocaleString("en-IN");

  if (s.segment === "100cc" && s.km) {
    const rec = s.km >= 60 ? "HF Deluxe — 83 kmpl, sabse zyada mileage" : "Splendor+ XTEC — 80 kmpl, India ka #1";
    return `${name}, 100cc mein ${s.km} km daily ke liye ${rec} best hai. Sirf ₹${fuel(s.km, 80)} mahine petrol. Test ride ke liye kab aayenge?`;
  }
  if (s.segment === "125cc" && s.km) {
    const rec = s.km >= 60 ? "Super Splendor XTEC — 65 kmpl, best 125cc mileage" : "Glamour X (style) ya Xtreme 125R (sporty)";
    return `${name}, 125cc mein aur ${s.km} km daily ke hisaab se ${rec} perfect hai. Saturday subah test ride karwa doon ya Sunday?`;
  }
  if (s.segment === "160cc+") {
    return `${name}, 160cc mein Xtreme 160R 2V daily commute ke liye perfect — 45 kmpl, sporty look. 4V version aur powerful hai. Dono ka test ride karwa deti hoon — kab aana suit karega?`;
  }
  if (s.segment === "scooter_110") {
    const rec = s.km && s.km >= 50 ? "Pleasure+ XTEC — 55 kmpl, best mileage" : s.familyUse ? "Destini 110 — family-friendly, wide seat" : "Pleasure+ XTEC — lightweight, easy";
    return `${name}, 110cc scooter mein ${rec} aapke liye best hai. Showroom aake ek baar dekh lein — test ride free hai. Kab convenient hai?`;
  }
  if (s.segment === "scooter_125") {
    const rec = s.familyUse ? "Destini 125 ZX — wide seat, family ke liye perfect" : "Xoom 125 — sporty, 50 kmpl, youth-friendly";
    return `${name}, 125cc scooter mein ${rec}. Test ride book kar deti hoon — Saturday ya Sunday, kab aayenge?`;
  }
  if (s.segment === "electric") {
    return `${name}, Vida V1 Pro 110 km range deta hai ek charge mein — petrol ka kharcha bilkul zero. Ghar pe charging point hai? Test ride karwa deti hoon, aap khud feel karenge.`;
  }

  // ── CLOSE — push showroom visit ────────────────────────────────────────────
  if (turn >= 3) {
    const closes = [
      `${name}, ek kaam karein — Saturday subah 11 baje showroom aa jaayein, main personally test ride ready rakhwa deti hoon. Plan ban sakta hai?`,
      `${name}, WhatsApp pe full price list aur EMI details bhej deti hoon abhi — number same hai na aapka?`,
      `${name}, abhi month-end pe special offers chal rahe hain — showroom aake dekh lein, 15-20 minute mein clear ho jaayega. Kab aayenge?`,
    ];
    return closes[count % closes.length] ?? closes[0]!;
  }
  return null;
}

// ── detectTopicShift ──────────────────────────────────────────────────────────
// Detects when the customer asks about something clearly different from what the
// agent was just talking about — used to flag a topic interrupt so the LLM
// answers the new question first.
function detectTopicShift(lastAgentText: string, customerText: string): boolean {
  // High-signal buckets only. Bare generic Hindi tokens (kitna / kab / kahan /
  // monthly / cost / rupee) are deliberately excluded — they match almost any
  // question and would fire spurious topic-interrupts on nearly every turn.
  const topics: Record<string, RegExp> = {
    scooter: /scooter|scooty|destini|pleasure|xoom|vida/i,
    bike: /\bbike\b|splendor|glamour|galemar|galaimer|xtreme|hf deluxe|passion|xpulse|bullet|cruise/i,
    price: /\bprice\b|on.?road|ex.?showroom|kitne ka|kitne ki|kimat|qeemat|कीमत/i,
    emi: /\bemi\b|finance|\bloan\b|kist|किस्त|down ?payment|installment/i,
    address: /\baddress\b|showroom kahan|\blocation\b|kahan hai|kahan ho|jagah/i,
    compare: /honda|bajaj|\btvs\b|yamaha|suzuki|compare|versus|\bvs\b/i,
    mileage: /mileage|kmpl|average|kitna deti|\bfuel\b/i,
    timing: /timing|kitne baje|kab khulta|kab tak|\bopen\b|band hota/i,
  };

  const topicOf = (text: string): string | null => {
    for (const [topic, regex] of Object.entries(topics)) {
      if (regex.test(text)) return topic; // first strong match wins
    }
    return null;
  };

  const agentTopic = topicOf(lastAgentText.toLowerCase());
  const customerTopic = topicOf(customerText.toLowerCase());
  return customerTopic !== null && agentTopic !== null && customerTopic !== agentTopic;
}

// ── isExplicitOptOut ──────────────────────────────────────────────────────────
// "Not interested" is a sales objection; "stop calling me" is a compliance
// instruction. Only the latter sets doNotCall.
function isExplicitOptOut(text: string): boolean {
  return /(?:mat\s+(?:karo|karna|kijiye)\s*(?:call|phone)|call\s+mat\s+(?:karo|karna|kijiye)|band\s+karo\s+call|call\s+band\s+karo|hata\s*(?:lo|do)\s+number|number\s+hata\s*(?:lo|do)|do\s+not\s+call|don'?t\s+call|stop\s+calling|\bdnd\b|block\s+(?:karo|kar\s+do)|मत\s+करो\s+(?:कॉल|फोन)|कॉल\s+मत\s+करो|बंद\s+करो\s+कॉल|हटा\s+लो\s+नंबर)/i.test(text);
}

// ── isCustomerAskingForHuman (unchanged from original) ────────────────────────
function isCustomerAskingForHuman(text: string): boolean {
  const t = text.toLowerCase();
  if (/(offer|discount|scheme|cashback|deal|price|kimat|qeemat|कीमत|emi|finance|कर्ज़|loan|kist|किस्त|mileage|माइलेज|stock|address|service|warranty|कब|when)/i.test(t)) {
    return false;
  }
  const patterns: RegExp[] = [
    /किसी\s+से\s+बात\s+(करा|करवा)/,
    /(sales|manager|senior|sales\s*expert)\s*(वाले|वाली|बंदे|भाई|व्यक्ति|person|wala|waale|staff|team|executive|representative|agent)\s*(से|se)\s+(बात|baat|connect|कनेक्ट)/i,
    /(connect|transfer|forward|put\s+me\s+through)\s+(me\s+|us\s+)?(to|with)\s+(a\s+|the\s+)?(sales|manager|human|senior|real\s+person|representative|agent)/i,
    /(talk|speak)\s+(to|with)\s+(a\s+|the\s+)?(human|real\s+person|manager|senior|sales\s+(person|guy|executive|expert))/i,
    /(असली|asli|real)\s+(व्यक्ति|person|aadmi|आदमी|insaan|इंसान)\s+(से|se)\s+(बात|baat)/i,
    /kisi\s+se\s+baat\s+(kara|karwa)/i,
    /(manager|senior)\s+(से|se)\s+baat\s+(karn[ai]|chahi|करनी|करना)/i,
  ];
  return patterns.some((re) => re.test(t));
}

// ── runTransfer (unchanged from original) ────────────────────────────────────
async function runTransfer(ws: WebSocket, session: Session, agentText: string): Promise<void> {
  const m = agentText.match(/^\s*\[TRANSFER(?::([A-Z]+))?(?::([^\]]+))?\]/i);
  const tag = (m?.[1] ?? "SALES").toUpperCase();
  const bankHint = m?.[2]?.trim().toUpperCase() ?? "";

  let target: typeof contactsTable.$inferSelect | undefined;
  const contacts = await db.select().from(contactsTable);
  const active = contacts.filter(c => c.isActive);
  if (tag === "FINANCE") {
    target = active.find(c => c.type === "finance" && bankHint && (c.bankName ?? "").toUpperCase().includes(bankHint))
      ?? active.find(c => c.type === "finance");
  } else {
    target = active.find(c => c.type === "sales");
  }
  const phone = target?.phone ?? process.env.SALES_TRANSFER_NUMBER ?? "";
  const targetLabel = target
    ? (target.type === "finance" ? (target.bankName ?? "Finance team") : target.name)
    : "sales expert";

  const addrName = session.leadName === "Sir" ? "सर" : session.leadName + " जी";
  const handoff = tag === "FINANCE"
    ? `एक मिनट ${addrName}, मैं आपको ${targetLabel} के finance expert से connect कर रही हूँ। Line पर रहिए।`
    : `एक मिनट ${addrName}, मैं आपको हमारे senior sales expert ${target ? target.name : ""} से connect कर रही हूँ। Line पर रहिए।`;
  session.transcript.push(`Agent: ${handoff}`);
  await streamTtsToWs(ws, session.streamSid, handoff, session.language, session);

  let transferred = false;
  if (phone && session.callSid) {
    await db.update(leadsTable).set({ status: "hot", score: 85 }).where(eq(leadsTable.id, session.leadId));
    transferred = await transferCallToAgent(session.callSid, phone);
  }

  // A transfer that silently fails strands the customer on a dead line after
  // "connect kar rahi hoon" — always speak the fallback and keep the lead hot.
  if (!transferred) {
    await db.update(leadsTable).set({ status: "hot", score: 85 }).where(eq(leadsTable.id, session.leadId));
    const sorry = `माफ़ कीजिए ${addrName}, अभी हमारा sales expert available नहीं है। मैं आपका नंबर note कर लेती हूँ, हम 5 मिनट में call back करेंगे।`;
    session.transcript.push(`Agent: ${sorry}`);
    await streamTtsToWs(ws, session.streamSid, sorry, session.language, session);
    logger.warn({ callSid: session.callSid, tag, bankHint, hadPhone: !!phone }, "Transfer not completed — spoke callback fallback");
  }
}

// ── TTS helpers (unchanged from original) ────────────────────────────────────
async function synthesizeTts(text: string, language: string): Promise<Int16Array | null> {
  const cached = getCachedPhrasePcm(text, language);
  if (cached) return cached;
  try {
    let ttsB64 = await textToSpeech(text, language);
    if (!ttsB64) {
      await new Promise((r) => setTimeout(r, 200));
      ttsB64 = await textToSpeech(text, language);
    }
    if (!ttsB64) { logger.warn({ textLen: text.length }, "TTS returned empty after retry"); return null; }
    const wavBuf = Buffer.from(ttsB64, "base64");
    const { pcm, sampleRate } = parseWav(wavBuf);
    const pcm8k = sampleRate === EXOTEL_SAMPLE_RATE ? pcm : resample(pcm, sampleRate, EXOTEL_SAMPLE_RATE);
    const GAIN = 0.75; const CEIL = 28000;
    const limited = new Int16Array(pcm8k.length);
    for (let i = 0; i < pcm8k.length; i++) {
      let s = pcm8k[i]! * GAIN;
      if (s > CEIL)  s = CEIL  + (s - CEIL)  * 0.15;
      if (s < -CEIL) s = -CEIL + (s + CEIL)  * 0.15;
      limited[i] = Math.max(-32768, Math.min(32767, Math.round(s)));
    }
    return limited;
  } catch (err) { logger.error({ err }, "TTS synth error"); return null; }
}

async function playPcm8k(ws: WebSocket, streamSid: string, pcm8k: Int16Array, session?: Session): Promise<void> {
  if (ws.readyState !== WebSocket.OPEN) return;
  const pcmBuf = s16ToPcm16Le(pcm8k);
  const totalChunks = Math.ceil(pcmBuf.length / CHUNK_BYTES);
  const t0 = Date.now();
  for (let n = 0; n < totalChunks; n++) {
    if (ws.readyState !== WebSocket.OPEN) break;
    if (session?.ttsAbort) { logger.info({ streamSid, sentChunks: n, totalChunks }, "TTS aborted mid-stream (barge-in)"); break; }
    const targetTime = t0 + n * 20;
    const wait = targetTime - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const start = n * CHUNK_BYTES;
    const chunk = pcmBuf.subarray(start, start + CHUNK_BYTES);
    ws.send(JSON.stringify({ event: "media", stream_sid: streamSid, streamSid, sequence_number: String(n + 1), media: { payload: chunk.toString("base64") } }));
  }
  if (!session?.ttsAbort && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ event: "mark", stream_sid: streamSid, streamSid, mark: { name: "tts_done" } }));
  }
}

async function streamTtsToWs(ws: WebSocket, streamSid: string, text: string, language: string, session?: Session): Promise<void> {
  if (ws.readyState !== WebSocket.OPEN) return;
  let myGen = 0;
  if (session) {
    session.isSpeaking = true;
    session.ttsAbort = false;
    session.bargeInCount = 0;
    session.speakingStartedAt = Date.now();
    myGen = ++session.ttsGen;
  }
  try {
    const pcm = await synthesizeTts(text, language);
    if (!pcm) return;
    if (session && (session.ttsAbort || session.isClosed || session.ttsGen !== myGen)) return;
    if (ws.readyState !== WebSocket.OPEN) return;
    await playPcm8k(ws, streamSid, pcm, session);
  } finally {
    if (session) {
      session.isSpeaking = false;
      session.ttsAbort = false;
      session.bargeInCount = 0;
      session.speakingStartedAt = undefined;
    }
  }
}
