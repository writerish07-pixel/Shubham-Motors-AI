/**
 * Transcribe a call recording (m4a, mp3, wav, etc.) using Sarvam saarika:v2.5.
 *
 * Why Sarvam (not OpenAI Whisper):
 *   • Replit's OpenAI proxy doesn't expose the audio API.
 *   • Sarvam is specialised for Indian languages — same engine the live
 *     agent already uses, so transcripts here match what the agent "hears".
 *
 * Sarvam's /speech-to-text endpoint caps at 30 s per request, so we use
 * ffmpeg to split the input into 25 s wav segments and transcribe each one,
 * stitching the results back together with offset timestamps.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts transcribe <audio-file> [lang]
 *   lang defaults to "hi-IN". Use "unknown" for auto-detection.
 */
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SARVAM_BASE = "https://api.sarvam.ai";
const CHUNK_SEC = 25;
const CONCURRENCY = 3;

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("close", (code) => code === 0 ? res() : rej(new Error(`${cmd} exited ${code}: ${err.slice(-400)}`)));
  });
}

async function transcribeChunk(path: string, language: string): Promise<string> {
  const buf = readFileSync(path);
  const form = new FormData();
  form.append("model", "saarika:v2.5");
  form.append("language_code", language);
  form.append("file", new Blob([new Uint8Array(buf)], { type: "audio/wav" }), "audio.wav");
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 30_000);
    const r = await fetch(`${SARVAM_BASE}/speech-to-text`, {
      method: "POST",
      headers: { "api-subscription-key": process.env.SARVAM_API_KEY ?? "" },
      body: form,
      signal: ctl.signal,
    });
    clearTimeout(t);
    if (!r.ok) {
      console.error(`  ! chunk ${path} HTTP ${r.status}:`, (await r.text()).slice(0, 300));
      return "";
    }
    const j = (await r.json()) as { transcript?: string };
    return (j.transcript ?? "").trim();
  } catch (err) {
    console.error(`  ! chunk ${path} failed:`, (err as Error).message);
    return "";
  }
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  const lang = process.argv[3] ?? "hi-IN";
  if (!arg) {
    console.error("Usage: pnpm --filter @workspace/scripts transcribe <audio-file> [lang]");
    process.exit(2);
  }
  const path = resolve(arg);
  const size = statSync(path).size;
  if (!process.env.SARVAM_API_KEY) {
    console.error("SARVAM_API_KEY not set.");
    process.exit(2);
  }
  console.error(`# Input: ${path} (${(size / 1024 / 1024).toFixed(1)} MB), lang=${lang}`);

  const tmp = mkdtempSync(join(tmpdir(), "transcribe-"));
  try {
    // Convert to mono 16 kHz wav and split into 25 s segments in one ffmpeg pass.
    console.error(`# Splitting into ${CHUNK_SEC}s chunks…`);
    await run("ffmpeg", [
      "-y", "-loglevel", "error",
      "-i", path,
      "-ac", "1", "-ar", "16000",
      "-f", "segment", "-segment_time", String(CHUNK_SEC),
      "-c:a", "pcm_s16le",
      join(tmp, "chunk_%03d.wav"),
    ]);
    const chunks = readdirSync(tmp).filter((f) => f.startsWith("chunk_")).sort();
    console.error(`# ${chunks.length} chunks. Transcribing with concurrency=${CONCURRENCY}…`);

    const results = new Array<string>(chunks.length).fill("");
    let cursor = 0;
    async function worker(): Promise<void> {
      while (true) {
        const i = cursor++;
        if (i >= chunks.length) return;
        const text = await transcribeChunk(join(tmp, chunks[i]!), lang);
        results[i] = text;
        process.stderr.write(`  ✓ ${i + 1}/${chunks.length}\n`);
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    console.log("# ── Per-chunk transcript (with timestamps) ──────────────");
    results.forEach((text, i) => {
      const start = i * CHUNK_SEC;
      const end = Math.min((i + 1) * CHUNK_SEC, Math.ceil(size / 1024)); // upper bound only for display
      console.log(`[${start}–${end}s]  ${text || "(silence / not recognised)"}`);
    });
    console.log("# ── Full transcript ─────────────────────────────────────");
    console.log(results.filter(Boolean).join(" "));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("Transcription failed:", err);
  process.exit(1);
});
