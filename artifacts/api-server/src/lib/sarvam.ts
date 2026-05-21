import axios from "axios";
import { logger } from "./logger";
import { prepareTtsText } from "./ttsPrep";

const SARVAM_BASE = "https://api.sarvam.ai";

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
        timeout: 30000,
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
        speech_sample_rate: 22050,
        pace: 0.95, // slow down ~5% for better Hinglish clarity
      },
      {
        headers: {
          "api-subscription-key": key(),
          "Content-Type": "application/json",
        },
        timeout: 20000,
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
        timeout: 5000,
      }
    );
    return response.data?.language_code ?? "hi-IN";
  } catch {
    return "hi-IN";
  }
}
