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
import { generateAgentReplyStream, analyzeCallIntent, learnFromTranscript } from "./openai";
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
const SILENCE_CHUNKS = 12;        // 12 × 20 ms = 240 ms silence → trigger STT (low-latency)
const MIN_SPEECH_CHUNKS = 8;      // 8 × 20 ms = 160 ms min speech
const MAX_SPEECH_CHUNKS = 600;    // 600 × 20 ms = 12 s max before forced trigger
const STT_SAMPLE_RATE = 16000;    // Sarvam STT wants 16 kHz
const EXOTEL_SAMPLE_RATE = 8000;  // Exotel sends 8 kHz linear PCM 16-bit
const CHUNK_BYTES = 320;          // 20 ms @ 8 kHz × 2 bytes/sample = 320 bytes (PCM16LE)

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
    void playPcm8k(ws, session.streamSid, cachedPcm, session).catch(() => {});
  } else {
    void streamTtsToWs(ws, session.streamSid, greeting, session.language, session).catch(() => {});
  }

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
    if (energy > SILENCE_RMS * 4) {
      session.bargeInCount = (session.bargeInCount ?? 0) + 1;
      if (session.bargeInCount >= 5) {
        session.ttsAbort = true;
        logger.info({ callSid: session.callSid, energy }, "Barge-in confirmed — stopping TTS");
        try {
          ws.send(JSON.stringify({ event: "clear", stream_sid: session.streamSid, streamSid: session.streamSid }));
        } catch { /* ws closed */ }
        session.bargeInCount = 0;
      }
    } else {
      session.bargeInCount = 0;
    }
    return; // ignore inbound audio while agent is speaking
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
      await sendCallSummaryWhatsApp(lead.phone, lead.name, analysis.summary, lead.interestedModel);
    }

    await learnFromTranscript(transcript, analysis.summary);
  } catch (err) {
    logger.error({ err, callSid: session.callSid }, "Error finalising call");
  }
}

// ── Core STT → LLM → TTS pipeline ────────────────────────────────────────────

async function runPipeline(ws: WebSocket, session: Session, chunks: Buffer[]): Promise<void> {
  if (ws.readyState !== WebSocket.OPEN) return;

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

  // Limit turns to keep costs reasonable
  if (session.turn > 10) {
    const bye = "धन्यवाद! हम जल्द आपसे संपर्क करेंगे। नमस्ते!";
    session.transcript.push(`Agent: ${bye}`);
    await streamTtsToWs(ws, session.streamSid, bye, session.language, session);
    return;
  }

  // Correct common STT mishears (Zoom→Xoom, Splendar→Splendor, etc.) BEFORE
  // either the direct router or the LLM sees the text. Saves us from refusing
  // a real in-stock model just because Sarvam dropped/added a letter.
  const correctedText = correctStt(customerText);
  if (correctedText !== customerText) {
    logger.info({ callSid: session.callSid, before: customerText, after: correctedText }, "STT alias corrected");
  }

  // ── Streaming LLM → pipelined TTS ─────────────────────────────────────────
  // We yield sentence-sized chunks from the LLM and start TTS on each as soon
  // as it arrives. While sentence N is being played, the synth for N+1 is
  // already in flight — this collapses end-to-end latency by ~3 s per turn.
  session.history.push({ role: "user", content: customerText });
  session.isSpeaking = true;
  session.ttsAbort = false;
  session.bargeInCount = 0;

  const collected: string[] = [];
  let playChain: Promise<void> = Promise.resolve();
  let transferText: string | null = null;

  try {
    for await (const sentence of generateAgentReplyStream(correctedText, session.history, session.leadName, session.language)) {
      if (session.ttsAbort) break;
      // Transfer tag is emitted as a single buffered chunk (see openai.ts)
      if (/^\s*\[TRANSFER/i.test(sentence)) {
        transferText = sentence;
        break;
      }
      collected.push(sentence);
      // Kick off TTS NOW; queue playback behind the previous one
      const myTts = synthesizeTts(sentence, session.language);
      const prev = playChain;
      playChain = (async () => {
        const pcm = await myTts;
        await prev;
        if (pcm && !session.ttsAbort && ws.readyState === WebSocket.OPEN) {
          await playPcm8k(ws, session.streamSid, pcm, session);
        }
      })();
    }
    await playChain;
  } finally {
    session.isSpeaking = false;
    session.ttsAbort = false;
    session.bargeInCount = 0;
  }

  const agentText = transferText ?? collected.join(" ").trim();
  logger.info({ callSid: session.callSid, agentText, streamed: collected.length }, "Agent reply");
  session.history.push({ role: "assistant", content: agentText });
  session.transcript.push(`Agent: ${agentText}`);

  // ── TRANSFER-TO-HUMAN ────────────────────────────────────────────────────
  // If the LLM is unsure / can't answer reliably, it emits a reply starting
  // with `[TRANSFER]`. We say a handoff line and transfer the live call to
  // the configured sales agent number. This prevents the AI from making up
  // wrong prices/offers — much better to hand off than to misinform.
  if (/^\s*\[TRANSFER/i.test(agentText)) {
    // Tag format:
    //   [TRANSFER] reason                          → sales
    //   [TRANSFER:FINANCE] reason                  → first active finance
    //   [TRANSFER:FINANCE:HDFC] reason             → specific bank, else any finance
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
    // Last-resort fallback to env var so existing deployments don't break
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
      // No contact in DB and no env fallback — tell the customer instead of silently dropping.
      const sorry = `माफ़ कीजिए ${addrName}, अभी हमारा sales expert available नहीं है। मैं आपका नंबर note कर लेती हूँ, हम 5 मिनट में call back करेंगे।`;
      session.transcript.push(`Agent: ${sorry}`);
      await streamTtsToWs(ws, session.streamSid, sorry, session.language, session);
      logger.warn({ callSid: session.callSid, tag, bankHint }, "Transfer requested but no contact configured");
    }
    return;
  }

  // Hot-lead detection
  const lower = customerText.toLowerCase();
  if (["buy", "book", "lena hai", "chahiye", "confirm", "ready", "le lunga"].some(s => lower.includes(s))) {
    await db.update(leadsTable).set({ status: "hot", score: 90 }).where(eq(leadsTable.id, session.leadId));
  }

  // TTS → send audio back
  await streamTtsToWs(ws, session.streamSid, agentText, session.language, session);
}

// ── Send TTS audio to Exotel over WebSocket ───────────────────────────────────

// Synthesize a single text fragment to Exotel-ready 8 kHz mono PCM16LE
// (gain-limited). Returns null on TTS failure.
async function synthesizeTts(text: string, language: string): Promise<Int16Array | null> {
  try {
    const ttsB64 = await textToSpeech(text, language);
    if (!ttsB64) return null;
    const wavBuf = Buffer.from(ttsB64, "base64");
    const { pcm, sampleRate } = parseWav(wavBuf);
    const pcm8k = sampleRate === EXOTEL_SAMPLE_RATE
      ? pcm
      : resample(pcm, sampleRate, EXOTEL_SAMPLE_RATE);

    // −6 dB gain + soft limiter. Sarvam output is hot and clips at 32767.
    const GAIN = 0.5;
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
  if (session) { session.isSpeaking = true; session.ttsAbort = false; session.bargeInCount = 0; }
  try {
    const pcm = await synthesizeTts(text, language);
    if (pcm) await playPcm8k(ws, streamSid, pcm, session);
  } finally {
    if (session) { session.isSpeaking = false; session.ttsAbort = false; session.bargeInCount = 0; }
  }
}
