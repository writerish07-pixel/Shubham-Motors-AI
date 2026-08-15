import axios from "axios";
import http from "http";
import https from "https";
import { logger } from "./logger";
import { prepareTtsText } from "./ttsPrep";

const SARVAM_BASE = "https://api.sarvam.ai";

// Hard timeouts — production showed Sarvam occasionally hangs for 30+ s.
const STT_TIMEOUT_MS = 6_000;
const TTS_TIMEOUT_MS = 5_000;
const LID_TIMEOUT_MS = 3_000;

// FIX: keepAlive HTTP agents — reuse TCP connections to Sarvam.
// Eliminates ~50ms TCP handshake on every STT/TTS call under sustained load.
const _httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 20 });
const _httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 20 });
const KEEP_ALIVE = { httpAgent: _httpAgent, httpsAgent: _httpsAgent };

function key() { return process.env.SARVAM_API_KEY ?? ""; }
function whisperKey() { return process.env.OPENAI_API_KEY ?? process.env.AI_INTEGRATIONS_OPENAI_API_KEY ?? ""; }

function normalizeLangCode(lang: string): string {
  if (lang.includes("-")) return lang;
  const map: Record<string, string> = {
    hi: "hi-IN", en: "en-IN", mr: "mr-IN",
    ta: "ta-IN", te: "te-IN", kn: "kn-IN",
    gu: "gu-IN", bn: "bn-IN", pa: "pa-IN", ml: "ml-IN",
  };
  return map[lang] ?? "hi-IN";
}

// ── Circuit breaker for Sarvam STT ───────────────────────────────────────────
// FIX: Under concurrent load, Sarvam STT can hit rate limits or hang.
// Circuit breaker: after 3 consecutive failures, open the circuit and use
// Whisper API fallback for 60 seconds, then half-open to retry Sarvam.
// This prevents all simultaneous calls from degrading at the same time.
interface CircuitBreakerState {
  failures: number;
  lastFailureAt: number;
  isOpen: boolean;
}
const _sttCircuit: CircuitBreakerState = { failures: 0, lastFailureAt: 0, isOpen: false };
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_RESET_MS = 60_000; // 60 seconds

function circuitAllowsSarvam(): boolean {
  if (!_sttCircuit.isOpen) return true;
  // Half-open: allow a probe after reset period
  if (Date.now() - _sttCircuit.lastFailureAt > CIRCUIT_RESET_MS) {
    _sttCircuit.isOpen = false;
    _sttCircuit.failures = 0;
    logger.info("Sarvam STT circuit breaker: half-open, probing Sarvam");
    return true;
  }
  return false;
}

function recordSarvamSuccess(): void {
  _sttCircuit.failures = 0;
  _sttCircuit.isOpen = false;
}

function recordSarvamFailure(): void {
  _sttCircuit.failures++;
  _sttCircuit.lastFailureAt = Date.now();
  if (_sttCircuit.failures >= CIRCUIT_FAILURE_THRESHOLD) {
    _sttCircuit.isOpen = true;
    logger.warn({ failures: _sttCircuit.failures }, "Sarvam STT circuit breaker: OPEN — switching to Whisper fallback");
  }
}

// ── Whisper fallback STT ──────────────────────────────────────────────────────
async function speechToTextWhisper(audioBuf: Buffer, language: string): Promise<string> {
  const k = whisperKey();
  if (!k) { logger.warn("Whisper fallback: no API key available"); return ""; }

  try {
    // Map Sarvam lang codes to Whisper language hints
    const langMap: Record<string, string> = {
      "hi-IN": "hi", "en-IN": "en", "mr-IN": "mr", "ta-IN": "ta",
      "te-IN": "te", "kn-IN": "kn", "gu-IN": "gu", "bn-IN": "bn",
    };
    const whisperLang = langMap[normalizeLangCode(language)] ?? "hi";

    const form = new FormData();
    form.append("model", "whisper-1");
    form.append("language", whisperLang);
    form.append("file", new Blob([new Uint8Array(audioBuf)], { type: "audio/wav" }), "audio.wav");

    const response = await axios.post(
      "https://api.openai.com/v1/audio/transcriptions",
      form,
      {
        headers: { Authorization: `Bearer ${k}` },
        timeout: 8_000,
        ...KEEP_ALIVE,
      }
    );

    const transcript = response.data?.text ?? "";
    logger.info({ transcript: transcript.slice(0, 60), fallback: "whisper" }, "Whisper STT result");
    return transcript;
  } catch (err) {
    logger.error({ err }, "Whisper STT fallback also failed");
    return "";
  }
}

// ── Public: speechToText (Sarvam with Whisper fallback) ───────────────────────
export async function speechToText(
  audioBuf: Buffer,
  language: string = "hi-IN"
): Promise<string> {
  // If circuit is open, skip Sarvam and go straight to Whisper
  if (!circuitAllowsSarvam()) {
    logger.debug("Sarvam STT circuit open — using Whisper fallback");
    return speechToTextWhisper(audioBuf, language);
  }

  try {
    const langCode = normalizeLangCode(language);
    const form = new FormData();
    form.append("model", "saarika:v2.5");
    form.append("language_code", langCode);
    form.append("file", new Blob([new Uint8Array(audioBuf)], { type: "audio/wav" }), "audio.wav");

    const response = await axios.post(
      `${SARVAM_BASE}/speech-to-text`,
      form,
      {
        headers: { "api-subscription-key": key() },
        timeout: STT_TIMEOUT_MS,
        ...KEEP_ALIVE,
      }
    );

    const transcript = response.data?.transcript ?? "";
    logger.debug({ transcript, langCode }, "Sarvam STT result");
    recordSarvamSuccess();
    return transcript;
  } catch (err: unknown) {
    const ae = err as { response?: { status?: number; data?: unknown }; code?: string };
    logger.error({ status: ae.response?.status, code: ae.code, body: ae.response?.data }, "Sarvam STT error");
    recordSarvamFailure();

    // Immediate fallback to Whisper on this call — don't make customer wait
    logger.info("Falling back to Whisper STT for this turn");
    return speechToTextWhisper(audioBuf, language);
  }
}

// ── Public: textToSpeech ─────────────────────────────────────────────────────
export async function textToSpeech(
  text: string,
  language: string = "hi-IN"
): Promise<string> {
  try {
    const langCode = normalizeLangCode(language);
    const speakable = prepareTtsText(text);

    const response = await axios.post(
      `${SARVAM_BASE}/text-to-speech`,
      {
        inputs: [speakable.slice(0, 500)],
        target_language_code: langCode,
        speaker: "anushka",
        // v2 is required for the ₹2/min cap; v3 is ~2×. Override only after a cost review.
        model: process.env.SARVAM_TTS_MODEL || "bulbul:v2",
        enable_preprocessing: true,
        // ── Clarity tuning — customer feedback: voice was fast / fumbled ──
        // pace < 1 slows delivery so every word is distinct; loudness lifts it
        // above phone-line noise. Generate at full 22.05 kHz and let the
        // anti-aliased resampler downsample to 8 kHz — far clearer than
        // synthesising natively at 8 kHz (which sounds thin and slurred).
        pace: 0.85,
        loudness: 1.2,
        speech_sample_rate: 22050,
      },
      {
        headers: {
          "api-subscription-key": key(),
          "Content-Type": "application/json",
        },
        timeout: TTS_TIMEOUT_MS,
        ...KEEP_ALIVE,
      }
    );

    const audios: string[] = response.data?.audios ?? [];
    return audios[0] ?? "";
  } catch (err: unknown) {
    const ae = err as { response?: { status?: number; data?: unknown } };
    logger.error({ status: ae.response?.status, body: ae.response?.data }, "Sarvam TTS error");
    return "";
  }
}

// ── Public: detectLanguage ───────────────────────────────────────────────────
export async function detectLanguage(text: string): Promise<string> {
  try {
    const response = await axios.post(
      `${SARVAM_BASE}/text-lid`,
      { input: text },
      {
        headers: {
          "api-subscription-key": key(),
          "Content-Type": "application/json",
        },
        timeout: LID_TIMEOUT_MS,
        ...KEEP_ALIVE,
      }
    );
    return response.data?.language_code ?? "hi-IN";
  } catch {
    return "hi-IN";
  }
}

// ── Export circuit breaker status for health endpoint ────────────────────────
export function getSttCircuitStatus(): { isOpen: boolean; failures: number; lastFailureAt: number } {
  return { ..._sttCircuit };
}
