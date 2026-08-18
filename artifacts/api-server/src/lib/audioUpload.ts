/** MIME + Whisper helpers for CRM "Upload Call" (Windows often sends octet-stream). */

const EXT_TO_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  mpeg: "audio/mpeg",
  mpga: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  webm: "audio/webm",
  amr: "audio/amr",
  "3gp": "audio/3gpp",
};

const MIME_TO_EXT: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
  "audio/amr": "amr",
  "audio/3gpp": "3gp",
};

const ALLOWED_PREFIXES = [
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/aac",
  "audio/ogg",
  "audio/webm",
  "audio/amr",
  "audio/3gpp",
];

export const WHISPER_LANGUAGE = "hi";

export const WHISPER_HINT =
  "Hero MotoCorp dealership sales call in Hindi and Hinglish. Shubham Motors, Jaipur. Models: Splendor, HF Deluxe, Passion, Glamour, Xtreme, Xpulse, Destini, Pleasure, Maestro, Karizma. Prices, EMI, test ride, exchange.";

export function inferAudioMime(filename: string, reported?: string): string | null {
  const raw = (reported ?? "").toLowerCase().trim();
  if (raw && raw !== "application/octet-stream" && raw !== "application/download") {
    if (ALLOWED_PREFIXES.some((p) => raw === p || raw.startsWith(`${p};`))) return raw.split(";")[0]!;
  }
  const ext = (filename.toLowerCase().split(".").pop() ?? "").replace(/[^a-z0-9]/g, "");
  return EXT_TO_MIME[ext] ?? null;
}

export function whisperFilename(original: string, mime: string): string {
  const name = (original || "recording").replace(/[/\\]/g, "_");
  if (/\.(mp3|wav|m4a|ogg|webm|mp4|mpeg|mpga|aac|amr|3gp)$/i.test(name)) return name;
  const ext = MIME_TO_EXT[mime.split(";")[0]!] ?? "mp3";
  return `${name}.${ext}`;
}

export function isUnsupportedAudioError(message: string): boolean {
  return /invalid|unsupported|could not|format|codec|audio file/i.test(message);
}
