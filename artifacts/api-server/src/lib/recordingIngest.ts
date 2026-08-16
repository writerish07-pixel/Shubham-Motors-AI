import { eq } from "drizzle-orm";
import { db, callsTable } from "@workspace/db";
import { logger } from "./logger";
import { learnFromTranscript } from "./openai";
import { downloadExotelMedia, fetchCallRecordingUrl } from "./exotel";
import { transcribeCallRecording } from "./sarvam";

/**
 * After Sakshi hands off, Voicebot is gone. Dual Exotel recording still
 * captures sales + customer. Transcribe it onto the call so the CRM can learn.
 */
export async function ingestExotelRecording(callSid: string, recordingUrl?: string): Promise<void> {
  if (!callSid) return;
  const url = (recordingUrl ?? "").trim() || await fetchCallRecordingUrl(callSid);
  if (!url) {
    logger.info({ callSid }, "No Exotel recording URL to ingest");
    return;
  }
  const buf = await downloadExotelMedia(url);
  if (!buf?.length) return;

  const stt = (await transcribeCallRecording(buf, "hi-IN")).trim();
  if (!stt) {
    logger.warn({ callSid, bytes: buf.length }, "Recording STT empty");
    return;
  }

  const [call] = await db.select().from(callsTable).where(eq(callsTable.exotelCallSid, callSid));
  if (!call) return;
  const existing = (call.transcript ?? "").trim();
  if (existing.includes("--- after transfer ---") || existing.includes("--- full recording ---")) {
    return;
  }
  const merged = existing
    ? `${existing}\n\n--- after transfer (sales + customer) ---\n${stt}`
    : `--- full recording ---\n${stt}`;
  await db.update(callsTable).set({ transcript: merged }).where(eq(callsTable.id, call.id));
  try {
    await learnFromTranscript(merged, call.summary ?? "", callSid);
  } catch (err) {
    logger.warn({ err, callSid }, "learnFromTranscript after recording ingest failed");
  }
  logger.info({ callSid, sttChars: stt.length }, "Saved post-transfer recording transcript");
}
