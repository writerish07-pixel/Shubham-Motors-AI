import axios from "axios";
import { logger } from "./logger";
import { prepareTtsText } from "./ttsPrep";

const SARVAM_BASE = "https://api.sarvam.ai";

// Hard timeouts — production showed Sarvam occasionally hangs for 30+ s on
// transient infrastructure issues. Without a tight cap the customer hears
// dead air for the full hang. Sane defaults: STT 6 s, TTS 5 s, LID 3 s.
// These match the legacy Python code's `*_TIMEOUT_SEC` constants which were
// proven in production.
const STT_TIMEOUT_MS = 6_000;
const TTS_TIMEOUT_MS = 5_000;
const LID_TIMEOUT_MS = 3_000;

function key() {
  return process.env.SARVAM_API_KEY ?? "";
}

function normalizeLangCode(lang: string): string {
  if (lang.includes("-")) return lang;
  const map: Record<string, string> = {
    hi: "hi-IN", en: "en-IN", mr: "mr-IN",
    ta: "ta-IN", te: "te-IN", kn: "kn-IN",
    gu: "gu-IN", bn: "bn-IN", pa: "pa-IN", ml: "ml-IN",
  };
  return map[lang] ?? "hi-IN";
}

/**
 * Speech-to-text via Sarvam saarika:v2.5
 * Accepts a raw audio Buffer (WAV, MP3, etc.) — max 30 seconds.
 * For longer audio, caller should chunk before calling.
 */
export async function speechToText(
  audioBuf: Buffer,
  language: string = "hi-IN"
): Promise<string> {
  try {
    const langCode = normalizeLangCode(language);

    // Sarvam STT requires multipart/form-data with a `file` field
    const form = new FormData();
    form.append("model", "saarika:v2.5");
    form.append("language_code", langCode);
    form.append("file", new Blob([audioBuf], { type: "audio/wav" }), "audio.wav");

    const response = await axios.post(
      `${SARVAM_BASE}/speech-to-text`,
      form,
      {
        headers: {
          "api-subscription-key": key(),
          // axios + FormData sets Content-Type automatically (multipart/form-data + boundary)
        },
        timeout: STT_TIMEOUT_MS,
      }
    );

    const transcript = response.data?.transcript ?? "";
    logger.debug({ transcript, langCode }, "Sarvam STT result");
    return transcript;
  } catch (err: unknown) {
    const ae = err as { response?: { status?: number; data?: unknown } };
    logger.error({ status: ae.response?.status, body: ae.response?.data }, "Sarvam STT error");
    return "";
  }
}

/**
 * Text-to-speech via Sarvam bulbul:v2
 * Returns base64-encoded WAV audio.
 */
export async function textToSpeech(
  text: string,
  language: string = "hi-IN"
): Promise<string> {
  try {
    const langCode = normalizeLangCode(language);
    // Convert English brand/model words → phonetic Devanagari so the customer
    // can clearly hear "Xoom 125" as "ज़ूम वन ट्वेंटी फाइव" instead of garble.
    const speakable = prepareTtsText(text);
    const response = await axios.post(
      `${SARVAM_BASE}/text-to-speech`,
      {
        inputs: [speakable.slice(0, 500)], // Sarvam TTS max ~500 chars per request
        target_language_code: langCode,
        speaker: "anushka",
        model: "bulbul:v2",
        enable_preprocessing: true,
        // Ask Sarvam for 8 kHz directly — Exotel needs 8 kHz, and Sarvam's
        // own resampler/anti-alias is better than our naive biquad. Cuts the
        // "metallic / muffled" artifact callers were complaining about and
        // also shaves ~30% off the TTS payload size (faster network).
        speech_sample_rate: 8000,
        // Default pace (1.0). The previous 0.95 made the voice sound dragged
        // and lengthened every reply by ~5% for no real clarity benefit.
      },
      {
        headers: {
          "api-subscription-key": key(),
          "Content-Type": "application/json",
        },
        timeout: TTS_TIMEOUT_MS,
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
      }
    );
    return response.data?.language_code ?? "hi-IN";
  } catch {
    return "hi-IN";
  }
}
