/**
 * Exotel Voicebot WebSocket handler.
 * Exotel opens a WS connection to /call/stream when a call connects.
 * (The /call path is registered in artifact.toml and the Replit production
 * proxy DOES pass WS upgrades through on this path. Do NOT move this to
 * /api/* — that was tried and broke production calls.)
 * Audio: G.711 μ-law, 8 kHz, 8-bit, mono (20 ms chunks = 160 bytes each).
 *
 * Flow per call:
 *   1. Receive start event → look up / create lead, send greeting via TTS
 *   2. Receive media events → buffer audio, detect silence, run STT
 *   3. STT text → OpenAI (with knowledge-base context) → TTS audio
 *   4. Send TTS audio back as media chunks
 *   5. Receive stop → finalise call record, run intent analysis, send WhatsApp
 */

import type { IncomingMessage } from "http";
import type { Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { eq, desc } from "drizzle-orm";
import { db, callsTable, leadsTable, followupsTable, contactsTable } from "@workspace/db";
import { speechToText, textToSpeech, detectLanguage } from "./sarvam";
import { detectIntent, getCachedPhrasePcm, warmPhraseCache } from "./voiceFastPath";
import { generateAgentReplyStream, analyzeCallIntent, learnFromTranscript, buildKnowledgeContext, getJaipurFuelPrice } from "./openai";
import { sendCallSummaryWhatsApp } from "./whatsapp";
import { resample, buildWav, parseWav, rmsEnergy } from "./audioCodec";
import { transferCallToAgent } from "./exotel";
import { extractCustomerName } from "./nameExtractor";
import { correctStt } from "./modelRouter";

// Exotel Voicebot media_format: { encoding: "base64", sample_rate: "8000", bit_rate: "128kbps" }
// 128 kbps ÷ 8000 Hz = 16 bits/sample → linear PCM 16-bit little-endian, mono. NOT μ-law.
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
const SILENCE_RMS = 0.008;        // Below this → silence
// 12 × 20 ms = 240 ms silence → trigger STT. Was 160 ms (8 chunks) but
// production showed customers' natural breath pauses chopped sentences in
// half (e.g. "देखो… मुझे हीरो स्कूटर के बारे में" → STT only got "देखो"),
// making it look like Sakshi ignored what they said. 240 ms is still snappy
// but lets a single natural pause through.
const SILENCE_CHUNKS = 12;
const MIN_SPEECH_CHUNKS = 8;      // 8 × 20 ms = 160 ms min speech
const MAX_SPEECH_CHUNKS = 600;    // 600 × 20 ms = 12 s max before forced trigger
const STT_SAMPLE_RATE = 16000;    // Sarvam STT wants 16 kHz
const EXOTEL_SAMPLE_RATE = 8000;  // Exotel sends 8 kHz linear PCM 16-bit
const CHUNK_BYTES = 320;          // 20 ms @ 8 kHz × 2 bytes/sample = 320 bytes (PCM16LE)

// ── Barge-in / echo-guard tuning ──────────────────────────────────────────────
// PRODUCTION LOGS showed dozens of false-positive "Barge-in" events firing at
// energies of 0.10–0.20 while only the agent was speaking — Exotel/PSTN was
// echoing our own TTS back into the inbound stream. The old guard (energy >
// 0.032, 5 frames = 100 ms) was nowhere near strict enough.
const BARGE_IN_RMS = SILENCE_RMS * 12;   // 0.096 — well above strong echo (~0.05) and below normal speech (~0.15)
const BARGE_IN_FRAMES = 10;              // 10 × 20 ms = 200 ms of continuous loud audio (snappier interruption)
const BARGE_IN_GRACE_MS = 400;           // First 400 ms ignored (TTS warmup echo); was 600 ms but felt unresponsive

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
  audioBuf: Buffer[];          // raw mulaw chunks since last STT
  silenceCount: number;
  speechCount: number;
  isProcessing: boolean;
  isClosed: boolean;
  isSpeaking?: boolean;      // true while agent TTS is being streamed out
  ttsAbort?: boolean;        // set to true to stop the in-flight TTS stream (barge-in)
  bargeInCount?: number;     // consecutive loud frames during TTS
  speakingStartedAt?: number; // ms timestamp; used for barge-in grace period
  // Monotonic counter incremented at the start of every speaking turn and
  // on every barge-in. Each queued playback task captures the value at
  // creation time and refuses to play if it no longer matches — this makes
  // stale in-flight TTS promises inert even after `ttsAbort` is reset by
  // runPipeline's finally block (preventing the "old reply audio replays
  // over customer's new sentence" race).
  ttsGen: number;
  // Snapshot of what we know about this customer at call start, passed to
  // every LLM turn so Sakshi can open warmly (e.g. "aapne pichli baar
  // Splendor pe interest dikhayi thi") instead of starting from scratch.
  leadProfile?: import("./openai").LeadProfile;
}

// ── Attach WebSocket server to existing HTTP server ───────────────────────────
export function setupVoicebotWS(httpServer: Server): void {
  const wss = new WebSocketServer({ server: httpServer, path: "/call/stream" });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
    let session: Session | null = null;

    ws.on("message", async (raw: Buffer | string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

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
            if (session && !session.isClosed) {
              await handleMedia(ws, session, msg);
            }
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
        await handleStop(session).catch((e) =>
          logger.error({ e }, "Error in WS close handler")
        );
      }
    });

    ws.on("error", (err) => logger.error({ err }, "Voicebot WS error"));
  });

  logger.info("Voicebot WebSocket server ready at /call/stream");
}

// ── Event handlers ────────────────────────────────────────────────────────────

async function handleStart(ws: WebSocket, msg: Record<string, unknown>): Promise<Session> {
  const start = (msg.start ?? {}) as Record<string, unknown>;
  // Exotel uses snake_case (call_sid, stream_sid); Twilio-style uses camelCase. Accept both.
  const callSid = String(
    start.callSid ?? start.call_sid ?? msg.callSid ?? msg.call_sid ?? ""
  );
  const streamSid = String(
    start.streamSid ?? start.stream_sid ?? msg.streamSid ?? msg.stream_sid ?? ""
  );
  const customParams = (start.customParameters ?? start.custom_parameters ?? {}) as Record<string, string>;
  const fromPhone = String(
    customParams.from ?? customParams.From ?? (start.from as string) ?? ""
  );

  logger.info({ callSid, streamSid }, "Call stream started");

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
        name: "",                       // unknown — agent will address as "Sir/Ma'am"
        phone: digits,
        status: "new",
        score: 0,
        source: "inbound_call",
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
      leadId: lead.id,
      direction: "inbound",
      status: "in_progress",
      exotelCallSid: callSid,
    }).returning();
    callDbId = newCall.id;
  }

  const session: Session = {
    callSid,
    streamSid,
    leadId: lead?.id ?? 0,
    leadName: (lead?.name && lead.name.trim() && !lead.name.startsWith("Lead ")) ? lead.name : "Sir",
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
    // Carry forward whatever the CRM knows about this caller so Sakshi can
    // personalise the conversation. lastCallSummary comes from the previous
    // call's `analyzeCallIntent` write (stored on the lead row as
    // `intentSummary`).
    leadProfile: lead ? {
      name: lead.name || undefined,
      interestedModel: lead.interestedModel ?? null,
      notes: lead.notes ?? null,
      lastCallSummary: lead.intentSummary ?? null,
      status: lead.status ?? null,
    } : undefined,
  };

  // Greet immediately — no artificial delay. If we have a pre-cached PCM for
  // the unknown-name greeting (warmed on boot), playback starts in ~150 ms
  // instead of waiting ~1.5 s for a Sarvam TTS round-trip.
  const knowsName = session.leadName !== "Sir";
  const greeting = knowsName
    ? `नमस्ते ${session.leadName} जी! मैं साक्षी बोल रही हूं, शुभम मोटर्स से। बताइए, मैं आपकी क्या help कर सकती हूँ?`
    : `नमस्ते! मैं साक्षी बोल रही हूं, शुभम मोटर्स से — Hero MotoCorp के अधिकृत डीलर। पहले आपका शुभ नाम जान सकती हूँ?`;
  session.transcript.push(`Agent: ${greeting}`);
  session.history.push({ role: "assistant", content: greeting });

  const cachedPcm = knowsName ? null : GREETING_CACHE.get(greeting);
  if (cachedPcm) {
    // Manage isSpeaking lifecycle ourselves so the inbound media branch
    // treats early customer audio as barge-in (not as input to STT).
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

  // Warm KB + fuel-price caches in parallel with greeting playback so the
  // first customer turn doesn't pay the cold-DB tax. Fire-and-forget; the
  // pipeline will hit the warm cache if it's ready, fall through to DB
  // otherwise. Both functions are dedup-safe via their in-flight promise.
  void Promise.all([buildKnowledgeContext(), getJaipurFuelPrice()]).catch(() => {});

  return session;
}

// ── Greeting TTS pre-cache ────────────────────────────────────────────────────
// The unknown-name Hindi greeting is identical for every cold inbound call.
// Warming its TTS once at boot saves ~1.5 s on time-to-first-word.
const GREETING_CACHE = new Map<string, Int16Array>();
const UNKNOWN_GREETING = `नमस्ते! मैं साक्षी बोल रही हूं, शुभम मोटर्स से — Hero MotoCorp के अधिकृत डीलर। पहले आपका शुभ नाम जान सकती हूँ?`;

async function warmGreetingCache(): Promise<void> {
  try {
    const pcm = await synthesizeTts(UNKNOWN_GREETING, "hi-IN");
    if (pcm) {
      GREETING_CACHE.set(UNKNOWN_GREETING, pcm);
      logger.info({ samples: pcm.length }, "Greeting TTS pre-cached");
    }
  } catch (err) {
    logger.warn({ err }, "Greeting pre-cache failed (non-fatal)");
  }
}
// Fire on module load — non-blocking. If Sarvam is slow at boot, the first
// real call falls back to a live TTS call automatically.
void warmGreetingCache();

// Warm the intent / phrase cache too — same idea, ~20 stock replies pre-
// synthesized so the agent can respond to "haan", "address kya hai", etc.
// in ~200 ms instead of ~1.5 s. Sequential inside warmPhraseCache to be
// nice to Sarvam at boot. Failures are logged but non-fatal — uncached
// phrases just fall through to a live TTS call.
void warmPhraseCache((text) => synthesizeTts(text, "hi-IN"));

async function handleMedia(ws: WebSocket, session: Session, msg: Record<string, unknown>): Promise<void> {
  const media = (msg.media ?? {}) as Record<string, unknown>;
  const payload = String(media.payload ?? "");
  if (!payload) return;

  const chunk = Buffer.from(payload, "base64");
  const pcm = pcm16LeToS16(chunk);
  const energy = rmsEnergy(pcm);

  // ── BARGE-IN with echo guard ──────────────────────────────────────────────
  // Risk: outbound TTS can echo back through the PSTN/Exotel path and either
  // (a) trigger a false barge-in that cuts off our own speech, or
  // (b) get fed into STT and produce loop-back transcripts.
  //
  // Guards:
  // 1. Require a much higher energy (4× silence floor) than normal speech
  //    detection so faint echo of own TTS doesn't qualify.
  // 2. Require 5 consecutive loud frames (~100 ms of continuous loud audio)
  //    before declaring barge-in.
  // 3. While isSpeaking is true, DO NOT buffer audio for STT — discard it.
  //    Real customer speech that triggers barge-in will be captured on
  //    subsequent frames once isSpeaking flips false.
  if (session.isSpeaking) {
    // ttsAbort already set in a previous frame → barge-in confirmed earlier
    // and the pipeline is still unwinding. STOP dropping audio: the
    // customer is mid-sentence right now, and we must capture it.
    // Falls through to the normal buffering branch below.
    if (session.ttsAbort) {
      session.isSpeaking = false;
      // fall through (do NOT return)
    } else {
      // Grace period: ignore the first ~600 ms of any agent reply. PSTN warmup
      // and Sarvam TTS attack often produce a louder leading transient that
      // looks like speech.
      const startedAt = session.speakingStartedAt ?? 0;
      if (startedAt && Date.now() - startedAt < BARGE_IN_GRACE_MS) {
        return;
      }

      if (energy > BARGE_IN_RMS) {
        session.bargeInCount = (session.bargeInCount ?? 0) + 1;
        if (session.bargeInCount >= BARGE_IN_FRAMES) {
          session.ttsAbort = true;
          // Bump the generation token so any TTS promise that was queued
          // for the now-aborted turn becomes inert — even if `ttsAbort`
          // later gets reset by runPipeline's finally before the stale
          // promise resolves, the gen mismatch will prevent it from ever
          // calling playPcm8k. Without this guard the customer would hear
          // old reply audio replay over their new sentence.
          session.ttsGen++;
          // CRITICAL: release isSpeaking immediately so the *next* inbound
          // audio frame buffers for STT instead of being discarded while
          // the pipeline tears down its in-flight TTS promises. Without
          // this we saw ~5–10 s of dead air after every barge-in — the
          // customer kept talking but Sakshi heard nothing because audio
          // was being dropped while playChain unwound.
          session.isSpeaking = false;
          logger.info({ callSid: session.callSid, energy }, "Barge-in confirmed — stopping TTS");
          try {
            ws.send(JSON.stringify({ event: "clear", stream_sid: session.streamSid, streamSid: session.streamSid }));
          } catch { /* ws closed */ }
          session.bargeInCount = 0;
          // Fall through so THIS frame's audio is also buffered — the
          // customer's barge-in word is real speech we want to capture.
        } else {
          return; // not enough confirmation yet
        }
      } else {
        session.bargeInCount = 0;
        return;
      }
    }
  }

  if (energy > SILENCE_RMS) {
    session.speechCount++;
    session.silenceCount = 0;
    session.audioBuf.push(chunk);
  } else {
    session.silenceCount++;
    if (session.speechCount > 0) session.audioBuf.push(chunk); // keep trailing silence
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

async function handleStop(session: Session): Promise<void> {
  logger.info({ callSid: session.callSid }, "Call stream stopped — analysing");
  // Tear down any in-flight TTS/LLM pipeline. Production showed cases where
  // the LLM kept streaming for 20 s after the call ended (wasted OpenAI cost
  // and confused logs with an "Agent reply played=0" long after the customer
  // had already hung up). The pipeline checks ttsAbort/isClosed and exits.
  session.ttsAbort = true;
  session.isSpeaking = false;
  session.ttsGen++; // invalidate any in-flight TTS promise from before hangup
  const transcript = session.transcript.join("\n");
  if (!transcript || !session.callDbId) return;

  try {
    const analysis = await analyzeCallIntent(transcript);

    await db.update(callsTable)
      .set({
        status: "completed",
        transcript,
        summary: analysis.summary,
        intentDetected: analysis.intent,
        scoreAfterCall: analysis.score,
        languageDetected: analysis.language,
      })
      .where(eq(callsTable.id, session.callDbId));

    const newStatus = analysis.score >= 80 ? "hot" : analysis.score >= 50 ? "interested" : "contacted";
    await db.update(leadsTable)
      .set({
        score: analysis.score,
        status: newStatus,
        language: analysis.language,
        intentSummary: analysis.summary,
        lastCallId: session.callDbId,
      })
      .where(eq(leadsTable.id, session.leadId));

    if (analysis.followupDate && analysis.followupReason) {
      await db.insert(followupsTable).values({
        leadId: session.leadId,
        scheduledAt: new Date(analysis.followupDate),
        reason: analysis.followupReason,
        intentLabel: analysis.intent,
        callId: session.callDbId,
        status: "pending",
      });
    }

    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, session.leadId));
    if (lead) {
      // Fire-and-forget — BotSpace's POST often takes 25+ s and was blocking
      // the post-call DB cleanup and learning pipeline. The customer doesn't
      // care if the summary text takes an extra 30 s to arrive; we do care
      // that the call record gets finalised promptly.
      void sendCallSummaryWhatsApp(lead.phone, lead.name, analysis.summary, lead.interestedModel)
        .catch((err) => logger.error({ err }, "Background WhatsApp summary failed"));
    }

    await learnFromTranscript(transcript, analysis.summary, session.callSid);
  } catch (err) {
    logger.error({ err, callSid: session.callSid }, "Error finalising call");
  }
}

// ── Core STT → LLM → TTS pipeline ────────────────────────────────────────────

async function runPipeline(ws: WebSocket, session: Session, chunks: Buffer[]): Promise<void> {
  if (ws.readyState !== WebSocket.OPEN) return;
  // If the call already ended (stop event received), don't burn an LLM/TTS
  // round trip for audio that nobody will hear.
  if (session.isClosed) return;

  // Concatenate PCM16LE chunks → PCM 8 kHz → upsample to 16 kHz → WAV
  const raw = Buffer.concat(chunks);
  const pcm8k = pcm16LeToS16(raw);
  const pcm16k = resample(pcm8k, EXOTEL_SAMPLE_RATE, STT_SAMPLE_RATE);
  const wavBuf = buildWav(pcm16k, STT_SAMPLE_RATE);

  // STT — pass raw Buffer (multipart/form-data)
  let customerText = await speechToText(wavBuf, session.language);
  if (!customerText?.trim()) return; // silence / noise, skip

  logger.info({ callSid: session.callSid, customerText }, "STT result");
  session.transcript.push(`Customer: ${customerText}`);

  // Detect language on first real turn — fire-and-forget so we don't add
  // ~500 ms to the customer's first reply. Worst case: turn 1 uses hi-IN
  // (same as greeting) and turn 2 onwards uses the detected language.
  if (session.turn === 0) {
    void detectLanguage(customerText)
      .then((lang) => { session.language = lang; })
      .catch(() => { /* keep hi-IN */ });
  }
  session.turn++;

  // Capture customer name ONLY on the very first customer turn — because the
  // greeting asked for the name. Trying on later turns produces false
  // positives ("mujhe Splendor chahiye" stored as a name).
  if (session.turn === 1 && session.leadName === "Sir") {
    const extracted = extractCustomerName(customerText);
    if (extracted) {
      session.leadName = extracted;
      if (session.leadId) {
        await db.update(leadsTable).set({ name: extracted }).where(eq(leadsTable.id, session.leadId));
      }
      logger.info({ callSid: session.callSid, name: extracted }, "Captured customer name");
    }
  }

  // Limit turns to keep costs reasonable. PRODUCTION BUG (WA-2026-05-28 14:33):
  // previous limit of 10 was hanging up hot leads mid-finance-conversation
  // with a farewell ("dhanyavaad, jald sampark karenge") when customer was
  // STILL asking about offers/EMIs. Raised to 25, and at the limit we
  // [TRANSFER] to a sales person instead of a cold goodbye — every
  // turn-25 conversation has earned a human handoff.
  if (session.turn > 25) {
    logger.info({ callSid: session.callSid, turn: session.turn }, "Turn limit reached → transfer to sales");
    await runTransfer(ws, session, "[TRANSFER] turn limit reached — long conversation, hand to sales");
    return;
  }

  // Correct common STT mishears (Zoom→Xoom, Splendar→Splendor, etc.) BEFORE
  // either the direct router or the LLM sees the text. Saves us from refusing
  // a real in-stock model just because Sarvam dropped/added a letter.
  const correctedText = correctStt(customerText);
  if (correctedText !== customerText) {
    logger.info({ callSid: session.callSid, before: customerText, after: correctedText }, "STT alias corrected");
  }

  // ── Customer-requested TRANSFER safety net ────────────────────────────────
  // PRODUCTION BUG (recording AUD-20260528-WA0003): customer said
  // "क्या आप मुझे किसी sales वाले से बात करा सकते हैं?" and Sakshi replied
  // "धन्यवाद हम जल्द आपसे संपर्क करेंगे" — ending the call instead of
  // transferring. The prompt tells the LLM to transfer, but the LLM is not
  // 100% reliable. This regex-based safety net runs BEFORE the LLM and forces
  // a [TRANSFER] tag whenever the customer explicitly asks to speak to a
  // human/sales/manager, so we never lose another hot lead to a farewell.
  if (isCustomerAskingForHuman(correctedText)) {
    session.history.push({ role: "user", content: customerText });
    if (session.history.length > 12) {
      session.history.splice(0, session.history.length - 12);
    }
    const tag = "[TRANSFER] customer explicitly asked to speak with a sales person";
    session.history.push({ role: "assistant", content: tag });
    session.transcript.push(`Agent[tag]: ${tag}`);
    logger.info({ callSid: session.callSid, correctedText }, "Customer-requested transfer (safety net)");
    await runTransfer(ws, session, tag);
    return;
  }

  // ── Intent fast-path ──────────────────────────────────────────────────────
  // For short common replies ("haan", "theek hai", "address kya hai", "test
  // ride", "EMI", "thanks", "busy", "callback") skip the LLM entirely and
  // play a cached Sakshi response. Cuts those turns from ~10 s to ~1 s and
  // also eliminates a class of hallucinations because there's no LLM in the
  // loop. Skipped on turn 0 so the LLM still handles greeting + name capture.
  const fastReply = detectIntent(correctedText, session.turn);
  if (fastReply) {
    // Push the user turn immediately (it really was said), but DEFER pushing
    // the assistant turn until playback confirms — mirrors the LLM path's
    // `played[]` discipline so a TTS failure / barge-in / call-end mid-turn
    // never leaves the transcript claiming Sakshi said something the
    // customer didn't actually hear.
    session.history.push({ role: "user", content: customerText });
    if (session.history.length > 12) {
      session.history.splice(0, session.history.length - 12);
    }
    session.isSpeaking = true;
    session.ttsAbort = false;
    session.bargeInCount = 0;
    session.speakingStartedAt = Date.now();
    const myGen = ++session.ttsGen;
    let actuallyPlayed = false;
    try {
      const pcm = await synthesizeTts(fastReply, session.language); // phrase-cache hit
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
      session.history.push({ role: "assistant", content: fastReply });
      session.transcript.push(`Agent: ${fastReply}`);
    }
    logger.info({ callSid: session.callSid, agentText: actuallyPlayed ? fastReply : "", played: actuallyPlayed ? 1 : 0, source: "fastpath" }, "Agent reply");
    return;
  }

  // ── Streaming LLM → pipelined TTS ─────────────────────────────────────────
  // We yield sentence-sized chunks from the LLM and start TTS on each as soon
  // as it arrives. While sentence N is being played, the synth for N+1 is
  // already in flight — this collapses end-to-end latency by ~3 s per turn.
  session.history.push({ role: "user", content: customerText });
  // Cap conversation history at the last 12 messages (6 exchanges). The
  // legacy Python code trimmed to 6 exchanges and that was proven in
  // production — going further than that just inflates the prompt without
  // helping the model. Smaller prompt = faster first token + lower
  // hallucination risk (the model can't drift into "remembering" facts from
  // 10 turns ago that weren't actually said).
  if (session.history.length > 12) {
    session.history.splice(0, session.history.length - 12);
  }
  session.isSpeaking = true;
  session.ttsAbort = false;
  session.bargeInCount = 0;
  session.speakingStartedAt = Date.now();
  // Capture this turn's generation token. Every queued playback task checks
  // it before sending audio so a barge-in (which increments ttsGen) makes
  // every still-in-flight TTS for THIS turn a no-op, regardless of when
  // their Sarvam HTTP requests eventually return.
  const myGen = ++session.ttsGen;

  // Track sentences that ACTUALLY made it to the customer's ear (TTS
  // succeeded + playback completed without abort). The transcript / LLM
  // history must reflect what was heard — not what we attempted. Previously
  // we stored every attempted sentence, so a TTS failure mid-reply produced
  // a transcript that didn't match what the customer heard.
  const played: string[] = [];
  let playChain: Promise<void> = Promise.resolve();
  let transferText: string | null = null;
  let attemptedCount = 0;
  let ttsFailures = 0;

  // Hard cap on how many sentences we'll actually pipeline to TTS, regardless
  // of what the LLM decides to emit. max_tokens=70 is a soft hint and Hindi
  // can fit 3+ sentences in 70 tokens (production showed a 24-second Zoom 125
  // monologue that the customer couldn't interrupt fast enough). 2 sentences
  // keeps every reply under ~6 s of audio so barge-in stays usable.
  const MAX_REPLY_SENTENCES = 2;

  try {
    for await (const sentence of generateAgentReplyStream(correctedText, session.history, session.leadName, session.language, session.leadProfile)) {
      if (session.ttsAbort || session.isClosed) break;
      // Transfer tag is emitted as a single buffered chunk (see openai.ts)
      if (/^\s*\[TRANSFER/i.test(sentence)) {
        transferText = sentence;
        break;
      }
      attemptedCount++;
      // Kick off TTS NOW; queue playback behind the previous one
      const myTts = synthesizeTts(sentence, session.language);
      const prev = playChain;
      playChain = (async () => {
        const pcm = await myTts;
        await prev;
        if (!pcm) { ttsFailures++; return; }
        // Generation guard: if barge-in / next turn / call-end bumped
        // ttsGen since this task was queued, drop on the floor.
        if (session.ttsAbort || session.isClosed || session.ttsGen !== myGen || ws.readyState !== WebSocket.OPEN) return;
        await playPcm8k(ws, session.streamSid, pcm, session);
        if (!session.ttsAbort && session.ttsGen === myGen) played.push(sentence);
      })();
      if (attemptedCount >= MAX_REPLY_SENTENCES) break;
    }
    // On barge-in we deliberately DO NOT wait for in-flight TTS promises to
    // resolve — they'll finish in the background and become no-ops because
    // ttsAbort is checked again before playback. Waiting here was the source
    // of the dead-air window after barge-in.
    if (!session.ttsAbort && !session.isClosed) await playChain;
  } finally {
    session.isSpeaking = false;
    session.ttsAbort = false;
    session.bargeInCount = 0;
    session.speakingStartedAt = undefined;
  }

  // History/transcript must reflect what the customer ACTUALLY heard.
  // If a transfer tag fired after some sentences were already spoken, log
  // both the spoken text and the transfer event — not just the tag.
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
  logger.info({
    callSid: session.callSid,
    agentText,
    attempted: attemptedCount,
    played: played.length,
    ttsFailures,
    transfer: !!transferText,
  }, "Agent reply");

  // ── TRANSFER-TO-HUMAN ────────────────────────────────────────────────────
  // If the LLM emitted a [TRANSFER…] tag, hand off the live call. Common path
  // for "I can't answer this from KB" / negotiation / explicit human request.
  if (/^\s*\[TRANSFER/i.test(agentText)) {
    await runTransfer(ws, session, agentText);
    return;
  }

  // Hot-lead detection
  const lower = customerText.toLowerCase();
  if (["buy", "book", "lena hai", "chahiye", "confirm", "ready", "le lunga"].some(s => lower.includes(s))) {
    await db.update(leadsTable).set({ status: "hot", score: 90 }).where(eq(leadsTable.id, session.leadId));
  }

  // No final streamTtsToWs() here — the streaming pipeline above already
  // synthesized and played every sentence in `collected`. Calling it again
  // would double-speak the entire reply.
}

/**
 * Detect customer phrases that mean "please connect me to a human/sales/manager".
 * Used as a safety net BEFORE the LLM runs so we never repeat the production bug
 * where the LLM said farewell instead of triggering [TRANSFER].
 *
 * Covers Hindi, Hinglish, and English variants. Tuned to be specific — single
 * words like "sales" alone are NOT triggers (customer might be asking about
 * "sales offer"). Requires a verb of asking/connecting paired with a human
 * subject (sales person / manager / human / kisi se baat).
 */
function isCustomerAskingForHuman(text: string): boolean {
  const t = text.toLowerCase();
  // EXCLUSION GUARD — if the sentence is clearly ABOUT a topic (offers,
  // discounts, schemes, EMI, finance, price), do NOT trigger transfer even if
  // it incidentally contains "sales". Customer is asking a question, not
  // asking to be handed off. This prevents false transfers on phrases like
  // "mujhe sales offer ke baare mein baat karni hai".
  if (/(offer|discount|scheme|cashback|deal|price|kimat|qeemat|कीमत|emi|finance|कर्ज़|loan|kist|किस्त|mileage|माइलेज|stock|address|service|warranty|कब|when)/i.test(t)) {
    return false;
  }
  // TRIGGER PATTERNS — each requires both an explicit handoff verb and a
  // "human / sales person / manager" noun (NOT just the word "sales").
  const patterns: RegExp[] = [
    // Hindi: "किसी से बात कराओ/कराइए/करवा दो"
    /किसी\s+से\s+बात\s+(करा|करवा)/,
    // Hindi/Hinglish: "sales वाले से बात कराओ", "sales वाले से बात करा सकते"
    // Requires the qualifier word (वाले/वाली/person/wala/staff/team) — bare
    // "sales se baat" by itself is too ambiguous.
    /(sales|manager|senior|sales\s*expert)\s*(वाले|वाली|बंदे|भाई|व्यक्ति|person|wala|waale|staff|team|executive|representative|agent)\s*(से|se)\s+(बात|baat|connect|कनेक्ट)/i,
    // Roman English: "connect me to sales/manager", "transfer to a human"
    /(connect|transfer|forward|put\s+me\s+through)\s+(me\s+|us\s+)?(to|with)\s+(a\s+|the\s+)?(sales|manager|human|senior|real\s+person|representative|agent)/i,
    /(talk|speak)\s+(to|with)\s+(a\s+|the\s+)?(human|real\s+person|manager|senior|sales\s+(person|guy|executive|expert))/i,
    // Hindi: "किसी असली व्यक्ति से बात"
    /(असली|asli|real)\s+(व्यक्ति|person|aadmi|आदमी|insaan|इंसान)\s+(से|se)\s+(बात|baat)/i,
    // Hinglish: "kisi se baat karwa do/karao do"
    /kisi\s+se\s+baat\s+(kara|karwa)/i,
    // Direct: "manager se baat karna hai/chahiye"
    /(manager|senior)\s+(से|se)\s+baat\s+(karn[ai]|chahi|करनी|करना)/i,
  ];
  return patterns.some((re) => re.test(t));
}

/**
 * Resolve a [TRANSFER…] tag to a real handoff: say a handoff line, transfer
 * the Exotel leg, mark the lead hot. Extracted from runPipeline so we can
 * also invoke it from the customer-side safety net (which runs BEFORE the LLM
 * and forms its own tag).
 */
async function runTransfer(ws: WebSocket, session: Session, agentText: string): Promise<void> {
  // Tag format:
  //   [TRANSFER] reason                  → sales
  //   [TRANSFER:FINANCE] reason          → first active finance
  //   [TRANSFER:FINANCE:HDFC] reason     → specific bank, else any finance
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

  if (phone && session.callSid) {
    await db.update(leadsTable).set({ status: "hot", score: 85 }).where(eq(leadsTable.id, session.leadId));
    await transferCallToAgent(session.callSid, phone);
  } else {
    const sorry = `माफ़ कीजिए ${addrName}, अभी हमारा sales expert available नहीं है। मैं आपका नंबर note कर लेती हूँ, हम 5 मिनट में call back करेंगे।`;
    session.transcript.push(`Agent: ${sorry}`);
    await streamTtsToWs(ws, session.streamSid, sorry, session.language, session);
    logger.warn({ callSid: session.callSid, tag, bankHint }, "Transfer requested but no contact configured");
  }
}

// ── Send TTS audio to Exotel over WebSocket ───────────────────────────────────

// Synthesize a single text fragment to Exotel-ready 8 kHz mono PCM16LE
// (gain-limited). Returns null on TTS failure. Retries once on transient
// Sarvam errors (production has shown intermittent 5xx/timeout for ~5% of
// requests — a single retry recovers most of them and prevents the customer
// from hearing only some sentences of a multi-sentence reply).
async function synthesizeTts(text: string, language: string): Promise<Int16Array | null> {
  // Phrase-cache hit: skip Sarvam entirely. Cached PCM has already been gain-
  // limited (it was synthesized via this same function during warm), so we
  // return it directly. Cache is keyed by language to prevent serving Hindi
  // audio inside an English call.
  const cached = getCachedPhrasePcm(text, language);
  if (cached) return cached;
  try {
    let ttsB64 = await textToSpeech(text, language);
    if (!ttsB64) {
      // Brief backoff then retry once
      await new Promise((r) => setTimeout(r, 200));
      ttsB64 = await textToSpeech(text, language);
    }
    if (!ttsB64) {
      logger.warn({ textLen: text.length }, "TTS returned empty after retry");
      return null;
    }
    const wavBuf = Buffer.from(ttsB64, "base64");
    const { pcm, sampleRate } = parseWav(wavBuf);
    const pcm8k = sampleRate === EXOTEL_SAMPLE_RATE
      ? pcm
      : resample(pcm, sampleRate, EXOTEL_SAMPLE_RATE);

    // −2.5 dB gain + soft limiter. PSTN expects hot levels; the previous
    // −6 dB was leaving callers asking "I can't hear you". Soft limiter
    // still prevents the residual clipping in loud Sarvam frames.
    const GAIN = 0.75;
    const CEIL = 28000;
    const limited = new Int16Array(pcm8k.length);
    for (let i = 0; i < pcm8k.length; i++) {
      let s = pcm8k[i]! * GAIN;
      if (s > CEIL)  s = CEIL  + (s - CEIL)  * 0.15;
      if (s < -CEIL) s = -CEIL + (s + CEIL)  * 0.15;
      limited[i] = Math.max(-32768, Math.min(32767, Math.round(s)));
    }
    return limited;
  } catch (err) {
    logger.error({ err }, "TTS synth error");
    return null;
  }
}

// Stream a pre-synthesized 8 kHz PCM buffer to Exotel, paced at 20 ms/chunk
// by absolute wall-clock so setTimeout jitter doesn't accumulate. Respects
// session.ttsAbort for barge-in.
async function playPcm8k(ws: WebSocket, streamSid: string, pcm8k: Int16Array, session?: Session): Promise<void> {
  if (ws.readyState !== WebSocket.OPEN) return;
  const pcmBuf = s16ToPcm16Le(pcm8k);
  const totalChunks = Math.ceil(pcmBuf.length / CHUNK_BYTES);
  const t0 = Date.now();
  for (let n = 0; n < totalChunks; n++) {
    if (ws.readyState !== WebSocket.OPEN) break;
    if (session?.ttsAbort) {
      logger.info({ streamSid, sentChunks: n, totalChunks }, "TTS aborted mid-stream (barge-in)");
      break;
    }
    const targetTime = t0 + n * 20;
    const wait = targetTime - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const start = n * CHUNK_BYTES;
    const chunk = pcmBuf.subarray(start, start + CHUNK_BYTES);
    ws.send(JSON.stringify({
      event: "media",
      stream_sid: streamSid,
      streamSid,
      sequence_number: String(n + 1),
      media: { payload: chunk.toString("base64") },
    }));
  }
  if (!session?.ttsAbort && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      event: "mark",
      stream_sid: streamSid,
      streamSid,
      mark: { name: "tts_done" },
    }));
  }
}

// Convenience wrapper used for one-shot lines (greeting fallback, handoff,
// goodbye, sorry). Manages session.isSpeaking lifecycle.
async function streamTtsToWs(ws: WebSocket, streamSid: string, text: string, language: string, session?: Session): Promise<void> {
  if (ws.readyState !== WebSocket.OPEN) return;
  // Capture a generation token for this one-shot line. If a barge-in /
  // next turn / hangup bumps ttsGen before our synth resolves, we drop
  // the audio on the floor instead of replaying it over the customer.
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
