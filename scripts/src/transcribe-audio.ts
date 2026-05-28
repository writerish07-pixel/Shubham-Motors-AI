/**
 * Transcribe an audio file (m4a, mp3, wav, webm, mp4, mpeg, mpga, ogg, flac)
 * using OpenAI Whisper. Used by the agent to "listen" to call recordings
 * the user shares.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts transcribe <path-to-audio>
 *
 * Output: prints the transcript to stdout (plain text). Whisper auto-detects
 * the language, so Hindi/English/Hinglish calls all work without a flag.
 */
import { createReadStream, statSync } from "node:fs";
import { resolve } from "node:path";
import OpenAI from "openai";

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: pnpm --filter @workspace/scripts transcribe <audio-file>");
    process.exit(2);
  }
  const path = resolve(arg);
  const size = statSync(path).size;
  if (size > 25 * 1024 * 1024) {
    console.error(`File too large for Whisper API (${(size / 1024 / 1024).toFixed(1)} MB, limit 25 MB).`);
    process.exit(2);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY not set.");
    process.exit(2);
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await client.audio.transcriptions.create({
    file: createReadStream(path),
    model: "whisper-1",
    response_format: "verbose_json",
    temperature: 0,
  });

  // verbose_json gives us per-segment timestamps — useful for analysing
  // call timing (who said what at which second).
  const verbose = res as unknown as {
    text: string;
    language?: string;
    duration?: number;
    segments?: Array<{ start: number; end: number; text: string }>;
  };
  console.log(`# Language: ${verbose.language ?? "?"}   Duration: ${verbose.duration?.toFixed(1) ?? "?"}s`);
  console.log("# ── Segments ─────────────────────────────────────────────");
  for (const seg of verbose.segments ?? []) {
    const ts = `${seg.start.toFixed(1)}–${seg.end.toFixed(1)}s`;
    console.log(`[${ts}]  ${seg.text.trim()}`);
  }
  console.log("# ── Full transcript ──────────────────────────────────────");
  console.log(verbose.text);
}

main().catch((err) => {
  console.error("Transcription failed:", err);
  process.exit(1);
});
