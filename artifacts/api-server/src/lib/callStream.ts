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
  convStageFromPurchaseStage,
  type LeadProfile,
  type DiscoverySignals,
  type ConvStage,
  type EmotionalTone,
} from "./openai";
import { resample, buildWav, parseWav, rmsEnergy } from "./audioCodec";
import { correctStt } from "./modelRouter";
import { getOutboundContext } from "./scheduler";  // FIX #6: outbound context
import { ensureSalesFollowUp, getMissingFollowUpSentence, shouldSpeakAnotherSentence } from "./salesFollowUp";
import { buildPurchaseVerificationGreeting, isFollowUpCall } from "./followUpCallContext";
import { buyingTimelineQuestion } from "./buyingTimeline";
import { CallCostCounters } from "./costMeter";
import { isBackchannel, parseAndStripTags, type AgentTag, applySessionLanguage, ttsLanguageCode, bargeInArmed, bargeInFramesNeeded, bargeInRmsThreshold, nextBargeInCount, parseJsonStringList, SILENCE_RMS } from "./agentTools";
import { executeAgentTools } from "./agentActions";
import { prepareTtsText } from "./ttsPrep";
import {
  bargeEnergyHits,
  formatAnsweredTransfer,
  formatQueuedTransfer,
  isCustomerAskingForHuman,
  isAgentPromisingTransfer,
  queueHumanTransferTeam,
  type TransferLeg,
} from "./humanTransfer";

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
import { StageTimer } from "./observability";
import { logger } from "./logger";

// ── Tuning constants ──────────────────────────────────────────────────────────
const SILENCE_CHUNKS = Number(process.env.VOICE_SILENCE_CHUNKS ?? 20); // ~400 ms EOU @ 20 ms — listen complete
const MIN_SPEECH_CHUNKS = 8;      // 160 ms min speech
const MAX_SPEECH_CHUNKS = 600;    // 12 s max before forced trigger
const STT_SAMPLE_RATE = 16000;
const EXOTEL_SAMPLE_RATE = 8000;
const CHUNK_BYTES = 320;          // 20 ms @ 8 kHz × 2 bytes/sample

// ── Barge-in / echo-guard ──────────────────────────────────────────────────────
const BARGE_IN_RMS = bargeInRmsThreshold();
const BARGE_IN_FRAMES = bargeInFramesNeeded();
/** Protect greeting only until first PCM (TTS wait). Playback is interruptible. */
const GREETING_PROTECT_MS = Number(process.env.VOICE_GREETING_PROTECT_MS ?? 25_000);

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
  finalized?: boolean;
  isSpeaking?: boolean;
  ttsAbort?: boolean;
  bargeInCount?: number;
  speakingStartedAt?: number;
  echoRms?: number;
  lastBargeInAt?: number;
  /** TTS-wait only. Cleared as soon as greeting PCM starts so barge-in works. */
  greetingProtectedUntil?: number;
  /** Human handoff started — do not keep talking or re-enter the pipeline. */
  transferStarted?: boolean;
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
  /** Per-call ₹ estimate (₹4/min budget). */
  cost: CallCostCounters;
  greetingPlayed?: boolean;
  bargeInEvents?: number;
  turnTimingsMs?: number[];
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
            try {
              session = await handleStart(ws, msg);
            } catch (err) {
              logger.error({ err }, "handleStart threw — playing emergency greeting");
              session = emergencySession(msg);
              void playGreetingAudio(ws, session, FALLBACK_GREETING).catch(() => {});
            }
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

  // Find or create lead — DB failure must not leave the PSTN line silent.
  let lead = null;
  try {
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
  } catch (err) {
    logger.error({ err, callSid }, "Lead lookup/create failed — greeting anyway");
    lead = null;
  }

  // Upsert call record
  let callDbId: number | null = null;
  try {
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
  } catch (err) {
    logger.error({ err, callSid }, "Call row upsert failed — greeting anyway");
  }

  // FIX #6: Read outbound context if this is an auto-dialer call.
  // Scheduler sets this in getOutboundContext(phone) before placing the call.
  const outboundCtx = isOutbound && fromPhone
    ? getOutboundContext(fromPhone.replace(/\D/g, "").slice(-10))
    : null;

  let priorCompletedCalls = 0;
  let lastTranscriptSnippet: string | null = null;
  try {
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
  } catch (err) {
    logger.error({ err, callSid }, "Prior-call lookup failed");
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
    purchaseStage: lead.purchaseStage ?? null,
    customerPersona: lead.customerPersona ?? null,
    objections: parseJsonStringList(lead.objections),
    promises: parseJsonStringList(lead.promises),
    locality: lead.locality ?? null,
    previousVehicle: lead.previousVehicle ?? null,
    exchangeVehicle: lead.exchangeVehicle ?? null,
    relationshipScore: lead.relationshipScore ?? null,
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
    purchaseStage: baseProfile?.purchaseStage,
    customerPersona: baseProfile?.customerPersona,
    objections: baseProfile?.objections,
    promises: baseProfile?.promises,
    locality: baseProfile?.locality,
    previousVehicle: baseProfile?.previousVehicle,
    exchangeVehicle: baseProfile?.exchangeVehicle,
    relationshipScore: baseProfile?.relationshipScore,
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
    if (lead.exchangeVehicle) priorSignals.exchangeInterest = true;
    if (lead.interestedModel) priorSignals.interestedModel = lead.interestedModel;
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
    finalized: false,
    ttsGen: 0,
    leadProfile,
    isOutbound,
    // NEW: initialise sales intelligence (seeded from prior-call CRM data)
    discoverySignals: priorSignals,
    convStage: convStageFromPurchaseStage(lead?.purchaseStage) ?? "connect",
    emotionalTone: "neutral",
    pendingQuestion: null,
    nameNeedsConfirmation: false,
    nameConfirmed: false,
    proactiveTimer: null,
    proactiveCount: 0,
    lastAgentSpokeAt: Date.now(),
    cost: new CallCostCounters(),
    greetingPlayed: false,
    bargeInEvents: 0,
    turnTimingsMs: [],
    transferStarted: false,
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
    greeting = `नमस्ते ${addrName}! मैं साक्षी बोल रही हूँ, शुभम मोटर्स से। ${outboundCtx.followupReason} — क्या अभी दो मिनट बात कर सकते हैं?`;
  } else if (leadName !== "Sir") {
    greeting = `नमस्ते ${leadName} जी! मैं साक्षी बोल रही हूँ, शुभम मोटर्स से। बताइए, मैं आपकी क्या मदद कर सकती हूँ?`;
  } else {
    greeting = `नमस्ते! मैं साक्षी बोल रही हूँ, शुभम मोटर्स से — Hero MotoCorp के अधिकृत डीलर। पहले आपका शुभ नाम जान सकती हूँ?`;
  }

  // DPDP recording notice — short, confident, mid-greeting (research: a legalistic
  // preamble kills conversion; a brief notice does not). Disable with RECORDING_NOTICE=0.
  if (RECORDING_NOTICE_ENABLED) greeting += ` ${RECORDING_NOTICE}`;

  session.transcript.push(`Agent: ${greeting}`);
  session.history.push({ role: "assistant", content: greeting });
  session.lastAgentSpokeAt = Date.now();
  // Wait ~10s after greeting before a proactive follow-up (was 6s — felt pushy).
  scheduleProactiveNudge(ws, session, 10000);

  void playGreetingAudio(ws, session, greeting)
    .then(() => {
      if (session.isClosed || session.transferStarted) return;
      if (session.speechCount >= MIN_SPEECH_CHUNKS) {
        session.silenceCount = Math.max(session.silenceCount, SILENCE_CHUNKS);
        kickPipeline(ws, session);
      }
    })
    .catch((err) => {
      logger.error({ err, callSid: session.callSid }, "Greeting playback failed");
    });

  void Promise.all([buildKnowledgeContext(), getJaipurFuelPrice()]).catch(() => {});
  return session;
}

// ── Greeting cache ────────────────────────────────────────────────────────────
const GREETING_CACHE = new Map<string, Int16Array>();
const RECORDING_NOTICE = "यह कॉल क्वालिटी के लिए रिकॉर्ड होती है।";
const RECORDING_NOTICE_ENABLED = process.env.RECORDING_NOTICE !== "0";
const UNKNOWN_GREETING_BASE = `नमस्ते! मैं साक्षी बोल रही हूँ, शुभम मोटर्स से — Hero MotoCorp के अधिकृत डीलर। पहले आपका शुभ नाम जान सकती हूँ?`;
const UNKNOWN_GREETING = RECORDING_NOTICE_ENABLED
  ? `${UNKNOWN_GREETING_BASE} ${RECORDING_NOTICE}`
  : UNKNOWN_GREETING_BASE;
const FALLBACK_GREETING = "नमस्ते, मैं साक्षी बोल रही हूँ शुभम मोटर्स से। सुन रही हूँ।";

function emergencySession(msg: Record<string, unknown>): Session {
  const start = (msg.start ?? {}) as Record<string, unknown>;
  const callSid = String(start.callSid ?? start.call_sid ?? msg.callSid ?? msg.call_sid ?? "");
  const streamSid = String(start.streamSid ?? start.stream_sid ?? msg.streamSid ?? msg.stream_sid ?? "");
  return {
    callSid, streamSid,
    leadId: 0,
    leadName: "Sir",
    callDbId: null,
    language: "hi-IN",
    history: [{ role: "assistant", content: FALLBACK_GREETING }],
    transcript: [`Agent: ${FALLBACK_GREETING}`],
    turn: 0,
    audioBuf: [],
    silenceCount: 0,
    speechCount: 0,
    isProcessing: false,
    isClosed: false,
    finalized: false,
    ttsGen: 0,
    isOutbound: false,
    discoverySignals: {},
    convStage: "connect",
    emotionalTone: "neutral",
    pendingQuestion: null,
    nameNeedsConfirmation: false,
    nameConfirmed: false,
    proactiveTimer: null,
    proactiveCount: 0,
    lastAgentSpokeAt: Date.now(),
    cost: new CallCostCounters(),
  };
}

async function playGreetingAudio(ws: WebSocket, session: Session, greeting: string): Promise<void> {
  session.greetingProtectedUntil = Date.now() + GREETING_PROTECT_MS;
  session.isSpeaking = true;
  session.ttsAbort = false;
  session.bargeInCount = 0;
  // Do not start the barge-in clock until PCM is actually leaving toward Exotel.
  session.speakingStartedAt = undefined;
  session.cost.addTtsText(greeting);
  try {
    let pcm = GREETING_CACHE.get(greeting) ?? null;
    if (!pcm) pcm = await synthesizeTts(greeting, session.language);
    if (!pcm) {
      logger.warn({ callSid: session.callSid, textLen: greeting.length }, "Greeting TTS empty — using fallback namaste");
      pcm = GREETING_CACHE.get(FALLBACK_GREETING) ?? await synthesizeTts(FALLBACK_GREETING, "hi-IN");
    }
    if (!pcm) {
      logger.error({ callSid: session.callSid }, "Greeting and fallback TTS both empty — line will be silent");
      return;
    }
    if (ws.readyState !== WebSocket.OPEN || session.isClosed) return;
    // Call 18: line noise during TTS wait set speechCount and skipped namaste,
    // so the customer heard silence then got dumped to sales. Always play namaste.
    session.speakingStartedAt = Date.now();
    await playPcm8k(ws, session.streamSid, pcm, session);
    if (!session.ttsAbort) session.greetingPlayed = true;
    logger.info({ callSid: session.callSid, samples: pcm.length, interrupted: Boolean(session.ttsAbort) }, "Greeting audio sent");
  } finally {
    endAgentSpeech(session);
  }
}

async function warmGreetingCache(): Promise<void> {
  try {
    const [unknown, fallback] = await Promise.all([
      synthesizeTts(UNKNOWN_GREETING, "hi-IN"),
      synthesizeTts(FALLBACK_GREETING, "hi-IN"),
    ]);
    if (unknown) { GREETING_CACHE.set(UNKNOWN_GREETING, unknown); logger.info({ samples: unknown.length }, "Greeting TTS pre-cached"); }
    if (fallback) { GREETING_CACHE.set(FALLBACK_GREETING, fallback); }
  } catch (err) { logger.warn({ err }, "Greeting pre-cache failed (non-fatal)"); }
}
void warmGreetingCache();
void warmPhraseCache((text) => synthesizeTts(text, "hi-IN"));

function sendExotelClear(ws: WebSocket, streamSid: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({ event: "clear", stream_sid: streamSid, streamSid }));
  } catch { /* ws closed */ }
}

/** Finish TTS. If the customer interrupted, keep inbound audio for STT. */
function endAgentSpeech(session: Session): void {
  const interrupted = session.ttsAbort === true;
  const customerWasTalking = (session.speechCount ?? 0) >= MIN_SPEECH_CHUNKS;
  session.isSpeaking = false;
  session.speakingStartedAt = undefined;
  session.bargeInCount = 0;
  session.greetingProtectedUntil = 0;
  if (!interrupted && !customerWasTalking) {
    session.audioBuf = [];
    session.speechCount = 0;
    session.silenceCount = 0;
  }
  session.ttsAbort = false;
}

// ── handleMedia ───────────────────────────────────────────────────────────────
async function handleMedia(ws: WebSocket, session: Session, msg: Record<string, unknown>): Promise<void> {
  const media = (msg.media ?? {}) as Record<string, unknown>;
  const payload = String(media.payload ?? "");
  if (!payload) return;

  const chunk = Buffer.from(payload, "base64");
  const pcm = pcm16LeToS16(chunk);
  const energy = rmsEnergy(pcm);

  // ── Barge-in: never drop inbound frames (call #9 barge_in_count=0).
  if (session.isSpeaking) {
    if (session.ttsAbort) {
      session.isSpeaking = false;
      // fall through — keep collecting the interrupt utterance
    } else {
      session.echoRms = (session.echoRms ?? SILENCE_RMS) * 0.85 + energy * 0.15;
      if (energy > SILENCE_RMS) {
        session.audioBuf.push(chunk);
        if (session.speechCount === 0) cancelProactiveTimer(session);
        session.speechCount++;
        session.silenceCount = 0;
      } else if (session.speechCount > 0) {
        session.silenceCount++;
        session.audioBuf.push(chunk);
      }
      if (!bargeInArmed(session)) {
        return;
      }
      const hits = bargeEnergyHits(energy, session.echoRms ?? SILENCE_RMS, BARGE_IN_RMS);
      session.bargeInCount = nextBargeInCount(session.bargeInCount ?? 0, hits ? energy : 0, BARGE_IN_RMS);
      if ((session.bargeInCount ?? 0) >= BARGE_IN_FRAMES) {
        session.ttsAbort = true;
        session.ttsGen++;
        session.isSpeaking = false;
        session.bargeInEvents = (session.bargeInEvents ?? 0) + 1;
        session.bargeInCount = 0;
        logger.info({ callSid: session.callSid, energy, echoRms: session.echoRms, buffered: session.audioBuf.length }, "Barge-in confirmed — stopping TTS");
        sendExotelClear(ws, session.streamSid);
        session.lastBargeInAt = Date.now();
        setTimeout(() => {
          if (session.isClosed || session.isProcessing) return;
          if (session.speechCount >= MIN_SPEECH_CHUNKS) {
            session.silenceCount = Math.max(session.silenceCount, SILENCE_CHUNKS);
            kickPipeline(ws, session);
          }
        }, 450);
        // fall through to end-of-utterance handling with the buffered interrupt
      } else {
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

  kickPipeline(ws, session);
}

function kickPipeline(ws: WebSocket, session: Session): void {
  if (session.isClosed || session.isProcessing || session.transferStarted) return;
  const totalChunks = session.audioBuf.length;
  const should =
    session.speechCount >= MIN_SPEECH_CHUNKS &&
    (session.silenceCount >= SILENCE_CHUNKS || totalChunks >= MAX_SPEECH_CHUNKS);
  if (!should) return;
  const buffered = session.audioBuf.splice(0);
  session.speechCount = 0;
  session.silenceCount = 0;
  session.isProcessing = true;
  runPipeline(ws, session, buffered)
    .catch((err) => logger.error({ err, callSid: session.callSid }, "Pipeline error"))
    .finally(() => {
      session.isProcessing = false;
      kickPipeline(ws, session);
    });
}

// ── handleStop ────────────────────────────────────────────────────────────────
async function handleStop(session: Session): Promise<void> {
  if (session.finalized) return;
  session.finalized = true;
  cancelProactiveTimer(session);
  logger.info({ callSid: session.callSid }, "Call stream stopped — analysing");
  session.ttsAbort = true;
  session.isSpeaking = false;
  const cost = session.cost.snapshot(session.isOutbound ? "outbound" : "inbound");
  logger.info({ callSid: session.callSid, cost }, "Call cost estimate (INR)");
  if (cost.overBudget) {
    logger.warn({ callSid: session.callSid, perMinInr: cost.perMinInr }, "Call exceeded ₹/min budget");
  }
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
      greetingPlayed: Boolean(session.greetingPlayed),
      bargeInCount: session.bargeInEvents ?? 0,
      avgTurnMs: session.turnTimingsMs?.length
        ? Math.round(session.turnTimingsMs.reduce((a, b) => a + b, 0) / session.turnTimingsMs.length)
        : undefined,
      costPerMinInr: Math.round(cost.perMinInr),
    });
  } catch (err) {
    logger.error({ err, callSid: session.callSid }, "Error finalising call");
  }
}

// ── runPipeline ───────────────────────────────────────────────────────────────
async function runPipeline(ws: WebSocket, session: Session, chunks: Buffer[]): Promise<void> {
  cancelProactiveTimer(session); // customer is speaking — cancel any pending nudge
  if (ws.readyState !== WebSocket.OPEN) return;
  if (session.isClosed || session.transferStarted) return;
  const timer = new StageTimer(undefined, session.turn);

  const raw = Buffer.concat(chunks);
  const pcm8k = pcm16LeToS16(raw);
  const pcm16k = resample(pcm8k, EXOTEL_SAMPLE_RATE, STT_SAMPLE_RATE);
  const wavBuf = buildWav(pcm16k, STT_SAMPLE_RATE);

  let customerText = await timer.time("stt", () => speechToText(wavBuf, session.language), "sarvam");
  const recentBarge = Boolean(session.lastBargeInAt && Date.now() - session.lastBargeInAt < 5000);
  if (!customerText?.trim()) {
    if (recentBarge) {
      const prompt = "जी बोलिए, मैं सुन रही हूँ।";
      session.transcript.push("Agent: " + prompt);
      await streamTtsToWs(ws, session.streamSid, prompt, session.language, session);
    }
    return;
  }
  session.cost.addSttSamples(pcm16k.length, STT_SAMPLE_RATE);

  logger.info({ callSid: session.callSid, customerText }, "STT result");

  // Backchannel (haan / achha / ji) must not start an LLM turn or steal the floor.
  // After barge-in, "haan" is often a clipped new question — ask them to repeat.
  if (isBackchannel(customerText)) {
    session.transcript.push(`Customer: ${customerText} [backchannel]`);
    logger.info({ callSid: session.callSid, customerText, recentBarge }, "Backchannel — keeping floor");
    if (recentBarge) {
      const prompt = "जी, क्या पूछना था?";
      session.transcript.push("Agent: " + prompt);
      await streamTtsToWs(ws, session.streamSid, prompt, session.language, session);
    }
    return;
  }

  session.transcript.push(`Customer: ${customerText}`);

  // Language detection on first turn — never flip Hinglish to en-IN (kills Hindi accent).
  if (session.turn === 0) {
    void detectLanguage(customerText)
      .then((lang) => { session.language = applySessionLanguage(session.language, lang, customerText); })
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
    session.speakingStartedAt = undefined;
    session.cost.addTtsText(fastWithFollowUp);
    const myGen = ++session.ttsGen;
    let actuallyPlayed = false;
    try {
      const pcm = await synthesizeTts(fastWithFollowUp, session.language);
      if (pcm && !session.ttsAbort && !session.isClosed && session.ttsGen === myGen && ws.readyState === WebSocket.OPEN) {
        await playPcm8k(ws, session.streamSid, pcm, session);
        if (!session.ttsAbort && session.ttsGen === myGen) actuallyPlayed = true;
      }
    } finally {
      endAgentSpeech(session);
    }
    if (actuallyPlayed) {
      session.history.push({ role: "assistant", content: fastWithFollowUp });
      session.transcript.push(`Agent: ${fastWithFollowUp}`);
      session.lastAgentSpokeAt = Date.now();
      scheduleProactiveNudge(ws, session, 8000);
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
  session.speakingStartedAt = undefined;
  const myGen = ++session.ttsGen;

  // Conditional thinking filler — only if first sentence takes >900ms (reduced, not every turn).
  const FILLER_DELAY_MS = Number(process.env.VOICE_FILLER_DELAY_MS ?? 700);
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
  let spokenDraft = "";
  const collectedTags: AgentTag[] = [];
  let interrupted = false;

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
      const parsed = parseAndStripTags(sentence);
      collectedTags.push(...parsed.tags);
      if (parsed.tags.some((t) => t.kind === "TRANSFER")) {
        transferText = sentence;
        if (!parsed.spoken) break;
      }
      if (parsed.spoken && isAgentPromisingTransfer(parsed.spoken)) {
        transferText = transferText ?? "[TRANSFER] agent promised human handoff";
      }
      if (!parsed.spoken) continue;
      attemptedCount++;
      spokenDraft = spokenDraft ? `${spokenDraft} ${parsed.spoken}` : parsed.spoken;
      session.cost.addTtsText(parsed.spoken);
      if (attemptedCount === 1) session.cost.addLlmCall("mini");
      const isFirstSentence = attemptedCount === 1;
      const myTts = synthesizeTts(parsed.spoken, session.language);
      const prev = playChain;
      playChain = (async () => {
        const pcm = await myTts;
        if (isFirstSentence) firstSentenceReady = true;
        await prev;
        if (!pcm) { ttsFailures++; return; }
        if (session.ttsAbort || session.isClosed || session.ttsGen !== myGen || ws.readyState !== WebSocket.OPEN) return;
        await playPcm8k(ws, session.streamSid, pcm, session);
        if (!session.ttsAbort && session.ttsGen === myGen) played.push(prepareTtsText(parsed.spoken));
      })();
      if (transferText || isAgentPromisingTransfer(spokenDraft)) break;
      if (!shouldSpeakAnotherSentence(spokenDraft, attemptedCount)) break;
    }
    if (!session.ttsAbort && !session.isClosed) await playChain;
  } finally {
    interrupted = Boolean(session.ttsAbort);
    endAgentSpeech(session);
  }

  const spoken = played.join(" ").trim();
  if (!transferText && isAgentPromisingTransfer(spoken || spokenDraft)) {
    transferText = "[TRANSFER] agent promised human handoff";
  }
  const agentText = transferText ?? spoken;
  if (spoken) {
    session.history.push({ role: "assistant", content: spoken });
    session.transcript.push(`Agent: ${spoken}`);
    if (!interrupted && !transferText) {
      const extra = getMissingFollowUpSentence(spoken, {
        signals: session.discoverySignals,
        convStage: session.convStage,
        turn: session.turn,
        customerText: correctedText,
        leadName: session.leadName,
      });
      if (extra) {
        await streamTtsToWs(ws, session.streamSid, extra, session.language, session);
        session.history.push({ role: "assistant", content: extra });
        session.transcript.push(`Agent: ${extra}`);
      }
    }
  } else if (!interrupted && spokenDraft && !transferText) {
    const follow = ensureSalesFollowUp(spokenDraft, {
      signals: session.discoverySignals,
      convStage: session.convStage,
      turn: session.turn,
      customerText: correctedText,
      leadName: session.leadName,
    });
    if (follow && follow !== spokenDraft) {
      await streamTtsToWs(ws, session.streamSid, follow, session.language, session);
      session.history.push({ role: "assistant", content: follow });
      session.transcript.push(`Agent: ${follow}`);
    }
  }
  if (transferText) {
    session.history.push({ role: "assistant", content: transferText });
    session.transcript.push(`Agent[tag]: ${transferText}`);
  }
  logger.info({ callSid: session.callSid, agentText, attempted: attemptedCount, played: played.length, ttsFailures, transfer: !!transferText, tags: collectedTags.map((t) => t.kind) }, "Agent reply");

  const actionTags = collectedTags.filter((t) => t.kind !== "TRANSFER");
  if (actionTags.length > 0 && session.leadId) {
    try {
      const tools = await executeAgentTools(actionTags, {
        leadId: session.leadId,
        callSid: session.callSid,
        language: session.language,
        customerText: correctedText,
        leadName: session.leadName,
      });
      if (tools.visitBookedAt) {
        session.transcript.push(`Agent[tag]: [VISIT] ${tools.visitBookedAt.toISOString()}`);
      }
      for (const extra of tools.spokenExtras) {
        if (!extra.trim() || interrupted) continue;
        session.history.push({ role: "assistant", content: extra });
        session.transcript.push(`Agent: ${extra}`);
        await streamTtsToWs(ws, session.streamSid, extra, session.language, session);
      }
    } catch (err) {
      logger.warn({ err, callSid: session.callSid }, "Agent tools failed");
    }
  }

  if (transferText || collectedTags.some((t) => t.kind === "TRANSFER")) {
    await runTransfer(ws, session, transferText ?? "[TRANSFER]");
    return;
  }

  // PROACTIVE: re-arm — if customer is silent ~4.5s after agent finishes, Sakshi continues
  if (!interrupted) {
    session.lastAgentSpokeAt = Date.now();
    scheduleProactiveNudge(ws, session, 8000);
  }

  // Hot-lead detection
  const lower = customerText.toLowerCase();
  if (["buy", "book", "lena hai", "chahiye", "confirm", "ready", "le lunga"].some(s => lower.includes(s))) {
    await db.update(leadsTable).set({ status: "hot", score: 90 }).where(eq(leadsTable.id, session.leadId));
  }
  const report = timer.report({ conversationId: session.callSid, customerId: session.leadId });
  session.turnTimingsMs = [...(session.turnTimingsMs ?? []), report.totalMs];
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
  if (session.isClosed || session.proactiveCount >= 2) return;

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
        scheduleProactiveNudge(ws, session, 8000);
      }
    } catch (err) {
      logger.error({ err }, "Proactive nudge TTS failed");
    } finally {
      endAgentSpeech(session);
    }
  }, delayMs);
}

// Picks the most valuable proactive line. Priority: segment → km → family →
// budget → current vehicle → segment-specific pitch → close.
function getProactiveMessage(session: Session): string | null {
  const s = session.discoverySignals;
  const name = session.leadName !== "Sir" && session.turn % 4 === 0 ? `${session.leadName} जी, ` : "";
  const turn = session.turn;
  const count = session.proactiveCount;

  // Customer hasn't said anything yet — never use this after turn 1 (call #12).
  if (turn === 0) {
    return "क्या आप सुन पा रहे हैं? बाइक या स्कूटर, जो देखना हो बताइए।";
  }

  // ── DISCOVERY — segment FIRST (cannot recommend without it) ────────────────
  if (!s.segment && count <= 2) {
    return `${name}एक छोटा सवाल — स्कूटर देख रहे हैं या बाइक? और कितने सीसी का — सौ, एक सौ पच्चीस, या कुछ और?`;
  }
  if (!s.km && count <= 3) {
    return `${name}रोज़ लगभग कितने किलोमीटर चलते हैं? उसी से माइलेज वाला मॉडल बताऊँगी।`;
  }
  if (s.segment?.startsWith("scooter") && s.familyUse === undefined && count <= 3) {
    return `${name}स्कूटर सिर्फ़ आप चलाएँगे या परिवार के लिए भी?`;
  }
  if (s.familyUse && !s.decisionMaker && count <= 3) {
    return `${name}खरीद का फ़ैसला आप खुद लेंगे या घर वालों के साथ?`;
  }
  if (!s.budget && count <= 4) {
    return `${name}बजट कैश में है या ई एम आई पर लेना है?`;
  }
  if (!s.currentVehicle && count <= 4) {
    return `${name}अभी क्या चला रहे हैं? पुरानी गाड़ी हो तो एक्सचेंज भी हो जाता है।`;
  }
  if (!s.buyingTimeline && count <= 4 && (s.segment || s.interestedModel)) {
    return `${name}, ${buyingTimelineQuestion(s.interestedModel)}`;
  }

  // Named this-call model: sell it — never pitch leftover Glamour on a Deluxe/Splendor call.
  if (s.interestedModel) {
    return `${name}${s.interestedModel} की टेस्ट राइड कब आएँगे — आज शाम या कल सुबह?`;
  }

  // ── SEGMENT-SPECIFIC PITCH ─────────────────────────────────────────────────
  if (s.segment === "100cc" && s.km) {
    const rec = s.km >= 60 ? "एच एफ डिलक्स — सबसे ज़्यादा माइलेज" : "स्प्लेंडर प्लस एक्सटेक";
    return `${name}सौ सीसी में रोज़ ${s.km} किलोमीटर के लिए ${rec} सही है। टेस्ट राइड कब आएँगे?`;
  }
  if (s.segment === "125cc" && s.km) {
    const rec = s.km >= 60 ? "सुपर स्प्लेंडर एक्सटेक" : "ग्लैमर एक्स या एक्सट्रीम";
    return `${name}एक सौ पच्चीस सीसी में ${rec} आपके लिए ठीक रहेगा। शनिवार सुबह टेस्ट राइड करवा दूँ या रविवार?`;
  }
  if (s.segment === "160cc+") {
    return `${name}एक सौ साठ सीसी में एक्सट्रीम रोज़ के लिए ठीक है। दोनों की टेस्ट राइड करवा दूँ — कब आना है?`;
  }
  if (s.segment === "scooter_110") {
    const rec = s.familyUse ? "डेस्टिनी" : "प्लेज़र प्लस एक्सटेक";
    return `${name}एक सौ दस सीसी स्कूटर में ${rec} आपके लिए सही है। टेस्ट राइड फ्री है — कब आना ठीक रहेगा?`;
  }
  if (s.segment === "scooter_125") {
    const rec = s.familyUse ? "डेस्टिनी" : "ज़ूम";
    return `${name}एक सौ पच्चीस सीसी स्कूटर में ${rec}। शनिवार या रविवार — कब आएँगे?`;
  }
  if (s.segment === "electric") {
    return `${name}विडा एक चार्ज में अच्छा रेंज देती है। घर पर चार्जिंग है? टेस्ट राइड करवा दूँ?`;
  }

  // ── CLOSE — push showroom visit ────────────────────────────────────────────
  if (turn >= 3) {
    const closes = [
      `${name}एक काम करें — शनिवार ग्यारह बजे शोरूम आ जाएँ, टेस्ट राइड तैयार रखवा दूँगी। प्लान बन सकता है?`,
      `${name}वॉट्सऐप पर कीमत और ई एम आई भेज दूँ — नंबर यही है ना?`,
      `${name}महीने के अंत में ऑफर चल रहे हैं — शोरूम आकर पंद्रह मिनट में क्लियर हो जाएगा। कब आएँगे?`,
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
    bike: /\bbike\b|splendor|glamour|galemar|galaimer|xtreme|hf deluxe|passion|xpulse|bullet|cruise|एच.?एफ|डीलक्स|स्प्लेंडर|ग्लैमर/i,
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

// ── runTransfer ──────────────────────────────────────────────────────────────
async function runTransfer(ws: WebSocket, session: Session, agentText: string): Promise<void> {
  if (session.transferStarted || session.isClosed) return;
  session.transferStarted = true;
  cancelProactiveTimer(session);
  const m = agentText.match(/^\s*\[TRANSFER(?::([A-Z]+))?(?::([^\]]+))?\]/i);
  const tag = (m?.[1] ?? "SALES").toUpperCase();
  const bankHint = m?.[2]?.trim().toUpperCase() ?? "";

  const contacts = await db.select().from(contactsTable);
  const active = contacts.filter(c => c.isActive);
  let legs: TransferLeg[] = [];
  if (tag === "FINANCE") {
    const finance = active.filter(c => c.type === "finance");
    const preferred = finance.find(c => bankHint && (c.bankName ?? "").toUpperCase().includes(bankHint))
      ?? finance[0];
    if (preferred) legs = [{ phone: preferred.phone, name: preferred.bankName ?? preferred.name }];
  } else {
    legs = active
      .filter(c => c.type === "sales")
      .map(c => ({ phone: c.phone, name: c.name }));
  }
  if (!legs.length && process.env.SALES_TRANSFER_NUMBER) {
    legs = [{ phone: process.env.SALES_TRANSFER_NUMBER, name: tag === "FINANCE" ? "फाइनेंस टीम" : "सीनियर सेल्स" }];
  }

  const teamLabel = legs.map(l => l.name).filter(Boolean).join(", ") || "सेल्स टीम";
  const addrName = session.leadName === "Sir" ? "सर" : session.leadName + " जी";
  const handoff = tag === "FINANCE"
    ? `एक मिनट ${addrName}, मैं आपको ${teamLabel} से जोड़ रही हूँ। लाइन पर रहिए।`
    : legs.length === 1
      ? `एक मिनट ${addrName}, मैं आपको हमारे सीनियर सेल्स ${legs[0]!.name} से जोड़ रही हूँ। लाइन पर रहिए।`
      : `एक मिनट ${addrName}, मैं आपको हमारे सेल्स टीम से जोड़ रही हूँ। जो भी एक्सपर्ट फ्री होगा, वो लाइन ले लेगा। लाइन पर रहिए।`;
  session.transcript.push(`Agent: ${handoff}`);
  await streamTtsToWs(ws, session.streamSid, handoff, session.language, session);

  const queued = queueHumanTransferTeam(session.callSid, legs);
  const transferRecord = legs.length === 1
    ? formatAnsweredTransfer(legs[0]!.name, legs[0]!.phone)
    : formatQueuedTransfer(legs);
  if (session.callSid && legs.length) {
    try {
      await db.update(callsTable)
        .set({ transferredTo: transferRecord })
        .where(eq(callsTable.exotelCallSid, session.callSid));
    } catch (err) {
      logger.warn({ err, callSid: session.callSid }, "Failed to persist transferredTo on handoff");
    }
  }

  await db.update(leadsTable).set({ status: "hot", score: 85 }).where(eq(leadsTable.id, session.leadId));
  session.transcript.push("Agent[tag]: voicebot closed for Exotel Transfer applet");
  logger.info({ callSid: session.callSid, tag, salesCount: legs.length, transferRecord, queued }, "Closing Voicebot WS for human Transfer applet");
  try {
    await handleStop(session);
  } catch (err) {
    logger.error({ err, callSid: session.callSid }, "Finalize before transfer close failed");
  }
  session.isClosed = true;
  try { ws.close(); } catch { /* already closing */ }
}

// ── TTS helpers (unchanged from original) ────────────────────────────────────
async function synthesizeTts(text: string, language: string): Promise<Int16Array | null> {
  const ttsLang = ttsLanguageCode(language);
  const cached = getCachedPhrasePcm(text, ttsLang) ?? getCachedPhrasePcm(text, language);
  if (cached) return cached;
  try {
    let ttsB64 = await textToSpeech(text, ttsLang);
    if (!ttsB64) {
      await new Promise((r) => setTimeout(r, 200));
      ttsB64 = await textToSpeech(text, ttsLang);
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
    if (session && !session.speakingStartedAt) session.speakingStartedAt = Date.now();
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
    // Barge-in clock starts only when the first PCM chunk is ready to send.
    session.speakingStartedAt = undefined;
    session.cost.addTtsText(text);
    myGen = ++session.ttsGen;
  }
  try {
    const pcm = await synthesizeTts(text, language);
    if (!pcm) {
      logger.warn({ textLen: text.length }, "TTS returned empty — skipping playback");
      return;
    }
    if (session && (session.ttsAbort || session.isClosed || session.ttsGen !== myGen)) return;
    if (ws.readyState !== WebSocket.OPEN) return;
    if (session) session.speakingStartedAt = Date.now();
    await playPcm8k(ws, streamSid, pcm, session);
  } finally {
    if (session) endAgentSpeech(session);
  }
}
