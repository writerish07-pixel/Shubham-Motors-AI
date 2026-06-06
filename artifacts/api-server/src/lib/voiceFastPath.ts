/**
 * voiceFastPath.ts
 *
 * Two latency wins ported from the previous Python codebase, combined into one
 * module because they're naturally coupled:
 *
 *   1. INTENT FAST-PATH
 *      For very common short customer replies ("haan", "theek hai", "address
 *      kya hai", "timing", "test ride", "EMI", "thanks", "busy", "callback",
 *      "not interested"), detect them with O(1) keyword lookup and reply with
 *      a fixed string — skipping the LLM round trip entirely. This is the
 *      biggest single latency win: those turns drop from ~10–15 s to ~1 s.
 *
 *   2. PHRASE CACHE
 *      The intent responses + a handful of common stock acknowledgements are
 *      TTS-synthesized once at server boot and kept as raw PCM in memory.
 *      When the agent (LLM or fast-path) emits one of these exact strings,
 *      playback is instant — no Sarvam call at all.
 *
 * Replies are written in *Sakshi's* voice (the current TS persona — female,
 * Shubham Motors, Hero MotoCorp), NOT Priya from the legacy code.
 */

import { logger } from "./logger";

// ─────────────────────────────────────────────────────────────────────────────
// INTENT MATCHING
// ─────────────────────────────────────────────────────────────────────────────

interface Intent {
  /** Multi-word phrases (substring match, case-insensitive). */
  phrases: string[];
  /** Single-token keywords (exact word match — avoids false positives like
   *  "han" inside "kahan"). */
  words: string[];
  /** Fixed Sakshi reply. Keep it under ~15 words so TTS is fast and barge-in
   *  works cleanly. */
  response: string;
}

// Order matters — more specific intents come first so "haan, busy hoon" hits
// `busy`, not a generic acknowledgement.
const INTENTS: Record<string, Intent> = {
  busy: {
    phrases: [
      "baad mein", "baad me", "abhi nahi", "abhi mat", "abhi busy",
      "free nahi", "time nahi", "meeting mein", "driving",
      "बाद में", "अभी नहीं", "अभी मत", "फ्री नहीं", "टाइम नहीं",
    ],
    words: ["busy", "later", "व्यस्त"],
    response: "कोई बात नहीं! आप कब free रहेंगे — मैं तब call करूँ?",
  },
  not_interested: {
    phrases: [
      "nahi chahiye", "interest nahi", "mat karo call", "band karo call",
      "hata lo number", "nahi lena", "no thanks", "zaroorat nahi",
      "नहीं चाहिए", "इंटरेस्ट नहीं", "मत करो कॉल", "बंद करो", "नहीं लेना",
      "जरूरत नहीं", "हटा लो नंबर",
    ],
    words: [],
    response: "जी ठीक है, आपका समय लेने के लिए माफ़ी। ज़रूरत हो तो ज़रूर call कीजिएगा। नमस्ते!",
  },
  callback: {
    phrases: [
      "call karo baad", "phone karo baad", "baad mein baat", "baad mein call",
      "call back", "कॉल बैक", "बाद में बात", "बाद में कॉल",
    ],
    words: [],
    response: "बिल्कुल, मैं call कर लूँगी — सुबह अच्छा रहेगा या शाम?",
  },
  address: {
    phrases: [
      "showroom kahan", "showroom ka address", "showroom ka pata",
      "kahan ho", "kahan hai", "kidhar ho", "google map", "showroom ki location",
      "शोरूम कहाँ", "शोरूम का पता", "शोरूम की लोकेशन",
    ],
    words: ["address", "location", "एड्रेस", "पता", "लोकेशन", "जगह"],
    response: "हम Lal Kothi, Tonk Road, Jaipur में हैं — सुबह ९ से शाम ७ बजे तक खुले हैं।",
  },
  timing: {
    phrases: [
      "kitne baje", "kab khulta", "band kab", "working hours",
      "showroom ka time", "showroom ki timing", "kab tak khula",
      "कितने बजे", "कब खुलता", "बंद कब", "कब तक खुला",
      "शोरूम की टाइमिंग", "शोरूम का टाइम",
    ],
    words: ["timing", "टाइमिंग", "समय"],
    response: "Monday से Saturday, सुबह ९ से शाम ७ बजे तक। आप कब आएँगे?",
  },
  test_ride: {
    phrases: [
      "test ride", "test drive", "chalake dekhna", "chalakar dekhna",
      "drive karna", "ride karna", "टेस्ट राइड", "टेस्ट ड्राइव",
      "चला के देखना", "चलाकर देखना",
    ],
    words: [],
    response: "Test ride बिल्कुल free है! आप कब आ सकते हैं — आज, कल, या weekend पर?",
  },
  thanks: {
    phrases: ["thank you", "thanks", "धन्यवाद", "शुक्रिया"],
    words: ["dhanyavaad", "shukriya", "thanku", "thnx"],
    response: "धन्यवाद आपका! कुछ और help चाहिए तो ज़रूर बताइए।",
  },
  // Generic short acknowledgements — only fire if NO other intent matched and
  // the utterance is short. Lets us respond to "haan", "OK", "theek hai" with
  // a discovery question instead of paying a 5-second LLM round trip.
  acknowledgement_short: {
    phrases: [
      "theek hai", "thik hai", "ok ji", "haan ji", "ji haan",
      "ठीक है", "हाँ जी", "जी हाँ", "हाँ हाँ",
    ],
    words: ["haan", "ok", "okay", "हाँ", "हां", "achha", "accha", "अच्छा"],
    response: "Bilkul! Ek baat batayein — bike sirf aap chalenge ya ghar mein koi aur bhi chalata hai? Family ke hisaab se recommend karungi.",
  },
};

/**
 * Returns a pre-canned Sakshi reply if the customer's utterance matches a
 * known intent, otherwise null (caller falls through to the LLM).
 *
 * NOTE: We deliberately do NOT fast-path on the very first customer turn so
 * Sakshi always has a chance to capture the customer's name / model interest
 * with the LLM. The pipeline increments `session.turn` BEFORE calling us, so
 * the first customer utterance arrives with turn === 1. Skip while turn < 2.
 */
export function detectIntent(text: string, turn: number): string | null {
  if (turn < 2) return null;
  const clean = text.toLowerCase().trim();
  if (clean.length < 2) return null;
  // If the customer said more than ~12 words, this is a real question — go
  // to the LLM. Fast-path is for short, common one-liners only.
  const wordCount = clean.split(/\s+/).length;
  if (wordCount > 12) return null;

  const wordSet = new Set(clean.split(/\s+/));

  for (const [name, intent] of Object.entries(INTENTS)) {
    // Acknowledgement is the broadest match — only allow it on utterances of
    // ≤4 words to avoid catching "haan main 100 km daily chalata hoon".
    if (name === "acknowledgement_short" && wordCount > 4) continue;

    for (const phrase of intent.phrases) {
      if (clean.includes(phrase.toLowerCase())) {
        logger.info({ intent: name, customerText: text.slice(0, 60) }, "Intent fast-path hit");
        return intent.response;
      }
    }
    for (const word of intent.words) {
      if (wordSet.has(word.toLowerCase())) {
        logger.info({ intent: name, customerText: text.slice(0, 60) }, "Intent fast-path hit");
        return intent.response;
      }
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// THINKING FILLERS — short phrases played INSTANTLY after STT while the LLM is
// still generating its first token. Eliminates the multi-second dead air the
// customer would otherwise hear between speaking and getting a reply. Rotated
// round-robin per turn. Pre-cached below so playback needs no live TTS call.
// ─────────────────────────────────────────────────────────────────────────────
export const THINKING_FILLERS: string[] = [
  "जी, समझ रही हूँ।",
  "अच्छा जी, एक second।",
  "हाँ जी, देखती हूँ।",
  "बिल्कुल, बताती हूँ।",
  "जी बिल्कुल, सोच रही हूँ।",
  "हाँ, समझ गयी।",
];

// ─────────────────────────────────────────────────────────────────────────────
// PHRASE CACHE — pre-synthesized PCM for stock replies
// ─────────────────────────────────────────────────────────────────────────────

// Every intent response, plus the thinking fillers and a few catch-all
// acknowledgements Sakshi falls back to. If the LLM (or filler path) emits any
// of these verbatim, we skip the Sarvam call.
const CACHED_PHRASES: string[] = [
  ...Object.values(INTENTS).map((i) => i.response),
  ...THINKING_FILLERS,
  // Common AI fallback / stalling phrases
  "जी, समझ रही हूँ। थोड़ा detail दीजिए?",
  "जी? एक बार फिर से बताइए?",
  "मैं manager से confirm करके बता देती हूँ।",
  "WhatsApp पर details भेज देती हूँ।",
  "आपका budget कितना है?",
  "एक minute, मैं check करती हूँ।",
];

// Cache key includes the LANGUAGE so a Hindi-rendered PCM is never served
// for an English/Marathi/etc. session — different language → different
// pronunciation/voice/sample-path, no cross-language reuse allowed.
const _phraseCache = new Map<string, Int16Array>();

/** Normalize for cache lookups — trim, lowercase, collapse whitespace. */
function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function cacheKey(text: string, language: string): string {
  return `${language}\u0000${normalize(text)}`;
}

/** Build the cache at server boot. `synth` is injected so this module stays
 *  free of TTS-pipeline dependencies (it doesn't import callStream).
 *
 *  All cached phrases here are Sakshi's stock Hindi/Hinglish lines, so we
 *  only warm them in `hi-IN`. If a call lands in another language the cache
 *  will simply miss and fall through to live TTS — correct behaviour. */
export async function warmPhraseCache(
  synth: (text: string) => Promise<Int16Array | null>,
): Promise<void> {
  const WARM_LANG = "hi-IN";
  let ok = 0;
  for (const phrase of CACHED_PHRASES) {
    try {
      const pcm = await synth(phrase);
      if (pcm) {
        _phraseCache.set(cacheKey(phrase, WARM_LANG), pcm);
        ok++;
      }
    } catch (err) {
      logger.warn({ err, phrase: phrase.slice(0, 40) }, "Phrase cache warm failed");
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  logger.info({ cached: ok, total: CACHED_PHRASES.length, language: WARM_LANG }, "Phrase cache warmed");
}

/** Returns cached PCM for an exact phrase + language match (after
 *  normalization), else null. We deliberately do NOT do fuzzy matching —
 *  serving the wrong audio for a semantically different sentence is worse
 *  than paying a TTS call. */
export function getCachedPhrasePcm(text: string, language: string): Int16Array | null {
  return _phraseCache.get(cacheKey(text, language)) ?? null;
}
