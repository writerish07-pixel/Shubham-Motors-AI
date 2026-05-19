/**
 * Exotel Voicebot WebSocket handler.
 * Exotel opens a WS connection to /call/stream when a call connects.
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
import { db, callsTable, leadsTable, followupsTable } from "@workspace/db";
import { speechToText, textToSpeech, detectLanguage } from "./sarvam";
import { generateAgentReply, analyzeCallIntent, learnFromTranscript } from "./openai";
import { sendCallSummaryWhatsApp } from "./whatsapp";
import { resample, buildWav, parseWav, rmsEnergy } from "./audioCodec";

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
const SILENCE_CHUNKS = 30;        // 30 × 20 ms = 600 ms silence → trigger STT
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
        name: `Lead ${digits.slice(-4)}`,
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
    leadName: lead?.name ?? "Customer",
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

  // Send Hindi greeting after a 200 ms gap
  setTimeout(async () => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const greeting =
      `नमस्ते ${session.leadName} जी! मैं प्रिया हूं, शुभम मोटर्स की AI सेल्स असिस्टेंट। ` +
      `हम Hero MotoCorp के अधिकृत डीलर हैं। आप किस Hero बाइक में रुचि रखते हैं?`;
    session.transcript.push(`Agent: ${greeting}`);
    session.history.push({ role: "assistant", content: greeting });
    await streamTtsToWs(ws, session.streamSid, greeting, session.language);
  }, 200);

  return session;
}

async function handleMedia(ws: WebSocket, session: Session, msg: Record<string, unknown>): Promise<void> {
  const media = (msg.media ?? {}) as Record<string, unknown>;
  const payload = String(media.payload ?? "");
  if (!payload) return;

  const chunk = Buffer.from(payload, "base64");
  const pcm = pcm16LeToS16(chunk);
  const energy = rmsEnergy(pcm);

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

  // Detect language on first real turn
  if (session.turn === 0) {
    try { session.language = await detectLanguage(customerText); } catch { /* keep */ }
  }
  session.turn++;

  // Limit turns to keep costs reasonable
  if (session.turn > 10) {
    const bye = "धन्यवाद! हम जल्द आपसे संपर्क करेंगे। नमस्ते!";
    session.transcript.push(`Agent: ${bye}`);
    await streamTtsToWs(ws, session.streamSid, bye, session.language);
    return;
  }

  // OpenAI with knowledge-base context
  const agentText = await generateAgentReply(customerText, session.history, session.leadName, session.language);
  logger.info({ callSid: session.callSid, agentText }, "Agent reply");

  session.history.push({ role: "user", content: customerText });
  session.history.push({ role: "assistant", content: agentText });
  session.transcript.push(`Agent: ${agentText}`);

  // Hot-lead detection
  const lower = customerText.toLowerCase();
  if (["buy", "book", "lena hai", "chahiye", "confirm", "ready", "le lunga"].some(s => lower.includes(s))) {
    await db.update(leadsTable).set({ status: "hot", score: 90 }).where(eq(leadsTable.id, session.leadId));
  }

  // TTS → send audio back
  await streamTtsToWs(ws, session.streamSid, agentText, session.language);
}

// ── Send TTS audio to Exotel over WebSocket ───────────────────────────────────

async function streamTtsToWs(ws: WebSocket, streamSid: string, text: string, language: string): Promise<void> {
  if (ws.readyState !== WebSocket.OPEN) return;

  try {
    const ttsB64 = await textToSpeech(text, language);
    if (!ttsB64) return;

    // Sarvam now returns 8kHz PCM directly — no resampling, no aliasing.
    const wavBuf = Buffer.from(ttsB64, "base64");
    const { pcm, sampleRate } = parseWav(wavBuf);
    const pcm8k = sampleRate === EXOTEL_SAMPLE_RATE
      ? pcm
      : resample(pcm, sampleRate, EXOTEL_SAMPLE_RATE);
    const pcmBuf = s16ToPcm16Le(pcm8k);

    // Pace by absolute wall-clock time so setTimeout jitter doesn't accumulate.
    // 320 bytes = 20 ms of PCM16LE audio @ 8 kHz. Schedule chunk N for t0 + N*20ms.
    // Exotel Voicebot protocol uses snake_case (stream_sid) in outbound frames.
    const totalChunks = Math.ceil(pcmBuf.length / CHUNK_BYTES);
    const t0 = Date.now();
    for (let n = 0; n < totalChunks; n++) {
      if (ws.readyState !== WebSocket.OPEN) break;
      const targetTime = t0 + n * 20;
      const now = Date.now();
      const wait = targetTime - now;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const start = n * CHUNK_BYTES;
      const chunk = pcmBuf.subarray(start, start + CHUNK_BYTES);
      ws.send(
        JSON.stringify({
          event: "media",
          stream_sid: streamSid,
          streamSid,
          sequence_number: String(n + 1),
          media: { payload: chunk.toString("base64") },
        })
      );
    }

    // Mark — lets us know when playback finished
    ws.send(JSON.stringify({
      event: "mark",
      stream_sid: streamSid,
      streamSid,
      mark: { name: "tts_done" },
    }));
  } catch (err) {
    logger.error({ err }, "TTS streaming error");
  }
}
