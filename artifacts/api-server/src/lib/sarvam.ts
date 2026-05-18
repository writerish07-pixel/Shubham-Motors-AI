import axios from "axios";
import { logger } from "./logger";

const SARVAM_API_KEY = process.env.SARVAM_API_KEY;
const SARVAM_BASE = "https://api.sarvam.ai";

export async function speechToText(audioBase64: string, language: string = "hi-IN"): Promise<string> {
  try {
    const response = await axios.post(
      `${SARVAM_BASE}/speech-to-text`,
      {
        model: "saarika:v2",
        language_code: normalizeLangCode(language),
        audio: audioBase64,
      },
      {
        headers: {
          "api-subscription-key": SARVAM_API_KEY,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      }
    );
    return response.data?.transcript ?? "";
  } catch (err) {
    logger.error({ err }, "Sarvam STT error");
    return "";
  }
}

export async function textToSpeech(text: string, language: string = "hi-IN"): Promise<string> {
  try {
    const response = await axios.post(
      `${SARVAM_BASE}/text-to-speech`,
      {
        inputs: [text],
        target_language_code: normalizeLangCode(language),
        speaker: "meera",
        model: "bulbul:v1",
        enable_preprocessing: true,
      },
      {
        headers: {
          "api-subscription-key": SARVAM_API_KEY,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );
    const audios: string[] = response.data?.audios ?? [];
    return audios[0] ?? "";
  } catch (err) {
    logger.error({ err }, "Sarvam TTS error");
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
          "api-subscription-key": SARVAM_API_KEY,
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

function normalizeLangCode(lang: string): string {
  if (lang.includes("-")) return lang;
  const map: Record<string, string> = {
    hi: "hi-IN",
    en: "en-IN",
    mr: "mr-IN",
    ta: "ta-IN",
    te: "te-IN",
    kn: "kn-IN",
    gu: "gu-IN",
    bn: "bn-IN",
    pa: "pa-IN",
    ml: "ml-IN",
  };
  return map[lang] ?? "hi-IN";
}
