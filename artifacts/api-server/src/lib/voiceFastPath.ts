/**
 * voiceFastPath.ts — intent fast-path + phrase cache (low-latency stock replies).
 */

import type { DiscoverySignals } from "./openai";
import { FINANCE_PARTNERS_LIST } from "./emiQuote";
import { logger } from "./logger";
import { isHardCallOptOut, isSoftRejection } from "./neverGiveUp";

interface Intent {
  phrases: string[];
  words: string[];
  response: string | ((ctx: FastPathContext) => string);
}

export interface FastPathContext {
  signals?: DiscoverySignals;
}

const INTENTS: Record<string, Intent> = {
  busy: {
    phrases: [
      "baad mein", "baad me", "abhi nahi", "abhi mat", "abhi busy",
      "free nahi", "time nahi", "meeting mein", "driving",
      "बाद में", "अभी नहीं", "अभी मत", "फ्री नहीं", "टाइम नहीं",
    ],
    words: ["busy", "later", "व्यस्त"],
    response: "कोई बात नहीं — आप कब फ्री रहेंगे? मैं तब कॉल करूँगी।",
  },
  not_interested: {
    phrases: [
      "mat karo call", "band karo call", "hata lo number", "call mat karo",
      "do not call", "don't call", "stop calling",
      "मत करो कॉल", "कॉल मत करो", "बंद करो कॉल", "हटा लो नंबर",
    ],
    words: ["dnd"],
    response: "ठीक है — ज़रूरत हो तो कॉल कीजिएगा। धन्यवाद।",
  },
  callback: {
    phrases: [
      "call karo baad", "phone karo baad", "baad mein baat", "baad mein call",
      "call back", "कॉल बैक", "बाद में बात", "बाद में कॉल",
    ],
    words: [],
    response: "मैं कॉल कर लूँगी — सुबह ठीक रहेगा या शाम?",
  },
  address: {
    phrases: [
      "showroom kahan", "showroom ka address", "showroom ka pata",
      "kahan ho", "kahan hai", "kidhar ho", "google map", "showroom ki location",
      "शोरूम कहाँ", "शोरूम का पता", "शोरूम की लोकेशन",
    ],
    words: ["address", "location", "एड्रेस", "पता", "लोकेशन", "जगह"],
    response: "हम लाल कोठी, टोंक रोड, जयपुर में हैं — सुबह नौ से शाम सात तक खुले हैं।",
  },
  timing: {
    phrases: [
      "kitne baje", "kab khulta", "band kab", "working hours",
      "showroom ka time", "showroom ki timing", "kab tak khula",
      "कितने बजे", "कब खुलता", "बंद कब", "कब तक खुला",
      "शोरूम की टाइमिंग", "शोरूम का टाइम",
    ],
    words: ["timing", "टाइमिंग", "समय"],
    response: "सोमवार से शनिवार सुबह नौ से शाम सात। आप कब आएँगे?",
  },
  test_ride: {
    phrases: [
      "test ride", "test drive", "chalake dekhna", "chalakar dekhna",
      "drive karna", "ride karna", "टेस्ट राइड", "टेस्ट ड्राइव",
      "चला के देखना", "चलाकर देखना",
    ],
    words: [],
    response: "टेस्ट राइड फ्री है — आज, कल, या वीकेंड कब ठीक रहेगा?",
  },
  finance: {
    phrases: [
      "finance karna", "finance lena", "loan lena", "loan chahiye", "emi pe lena",
      "finance chahiye", "finance karana", "finance karwana",
      "किस्त पर", "फाइनेंस", "लोन", "finance mein", "finance ke baare",
      "financing ke baare", "finance option",
    ],
    words: ["finance", "loan"],
    response: (ctx) => {
      const vehicle = ctx.signals?.segment?.startsWith("scooter") ? "स्कूटर" : "बाइक या स्कूटर";
      return `${FINANCE_PARTNERS_LIST} पहले बताइए कौन सा ${vehicle} और लगभग कितना डाउन पेमेंट दे सकते हैं — फिर मैं नौ प्रतिशत रेफरेंस पर ई एम आई बताऊँगी, असल रेट सिबिल पर बदल सकता है।`;
    },
  },
  thanks: {
    phrases: ["thank you", "thanks", "धन्यवाद", "शुक्रिया"],
    words: ["dhanyavaad", "shukriya", "thanku", "thnx"],
    response: "आपका धन्यवाद। और कुछ जानना हो तो बताइए।",
  },
  acknowledgement_short: {
    phrases: [
      "theek hai", "thik hai", "ok ji", "haan ji", "ji haan",
      "ठीक है", "हाँ जी", "जी हाँ", "हाँ हाँ",
    ],
    words: ["haan", "ok", "okay", "हाँ", "हां", "achha", "accha", "अच्छा"],
    response: "बाइक सिर्फ़ आप चलाएँगे या घर में कोई और भी? परिवार के हिसाब से बताऊँगी।",
  },
};

/** Skip finance fast-path on follow-up questions (tenure, down payment, repeat). */
function isFinanceFollowUp(text: string, signals?: DiscoverySignals): boolean {
  if (!signals?.financeInterest) return false;
  return /kitne\s*(mahine|month|मही|mes|mahino)|tenure|duration|\d+\s*(hajar|hazaar|hazar|हज़|000)|down\s*payment|dubara|phir\s*se|repeat|minimum|kam\s*emi|कितने\s*मही/i.test(
    text,
  );
}

/** First-time finance ask only — not "emi kitne month" follow-ups. */
function isFirstFinanceAsk(text: string, signals?: DiscoverySignals): boolean {
  if (signals?.financeInterest) return false;
  if (isFinanceFollowUp(text, signals)) return false;
  const clean = text.toLowerCase();
  if (/finance|loan|फाइनेंस|लोन|finance mein|financing|finance option/i.test(clean)) return true;
  if (/\bemi\b/i.test(clean) && /chahiye|lena|karna|option|kitna|calcul|calculate|batao|bataiye|बताओ/i.test(clean)) return true;
  return false;
}

export function detectIntentWithMeta(
  text: string,
  turn: number,
  ctx: FastPathContext = {},
): { name: string; response: string } | null {
  if (turn < 2) return null;
  const clean = text.toLowerCase().trim();
  if (clean.length < 2) return null;
  const wordCount = clean.split(/\s+/).length;
  if (wordCount > 12) return null;

  // DND is compliance. Soft "नहीं चाहिए" is a stall — do not say goodbye.
  if (isHardCallOptOut(text)) {
    const response = typeof INTENTS.not_interested.response === "string"
      ? INTENTS.not_interested.response
      : "ठीक है — ज़रूरत हो तो कॉल कीजिएगा। धन्यवाद।";
    logger.info({ intent: "not_interested", customerText: text.slice(0, 60) }, "Intent fast-path hit");
    return { name: "not_interested", response };
  }
  if (isSoftRejection(text)) return null;

  if (isFinanceFollowUp(text, ctx.signals)) return null;

  const wordSet = new Set(clean.split(/\s+/));

  for (const [name, intent] of Object.entries(INTENTS)) {
    if (name === "finance" && !isFirstFinanceAsk(text, ctx.signals)) continue;
    if (name === "acknowledgement_short" && wordCount > 4) continue;

    for (const phrase of intent.phrases) {
      if (clean.includes(phrase.toLowerCase())) {
        const response = typeof intent.response === "function" ? intent.response(ctx) : intent.response;
        logger.info({ intent: name, customerText: text.slice(0, 60) }, "Intent fast-path hit");
        return { name, response };
      }
    }
    for (const word of intent.words) {
      if (wordSet.has(word.toLowerCase())) {
        const response = typeof intent.response === "function" ? intent.response(ctx) : intent.response;
        logger.info({ intent: name, customerText: text.slice(0, 60) }, "Intent fast-path hit");
        return { name, response };
      }
    }
  }
  return null;
}

export function detectIntent(text: string, turn: number, ctx?: FastPathContext): string | null {
  return detectIntentWithMeta(text, turn, ctx)?.response ?? null;
}

/** Thinking audio only for slow EMI/price lookups — not every turn. */
export const THINKING_FILLERS: string[] = [];

const FILLER_PRICE = "कीमत देख रही हूँ।";
const FILLER_EMI = "ई एम आई निकाल रही हूँ।";

/**
 * Almost never speak a filler. Live calls stacked "ek second" every turn.
 * Only EMI / price questions after turn 1 may get a short hold line.
 */
export function pickThinkingFiller(customerText: string, turn: number): string {
  if (turn < 2) return "";
  const t = customerText.toLowerCase();
  if (/\bemi\b|finance|\bloan\b|kist|किस्त|फाइनेंस|लोन|down\s*payment/i.test(t)) return FILLER_EMI;
  if (/price|kitne\s*(ka|ki|mein)|kimat|qeemat|कीमत|on.?road|rate|कितने/i.test(t)) return FILLER_PRICE;
  return "";
}

const CACHED_PHRASES: string[] = [
  ...Object.values(INTENTS).flatMap((i) =>
    typeof i.response === "function" ? [i.response({})] : [i.response],
  ),
  ...THINKING_FILLERS,
  FILLER_PRICE,
  FILLER_EMI,
  "समझ रही हूँ — थोड़ा और बताइए?",
  "एक बार फिर से बताइएगा?",
  "वॉट्सऐप पर डिटेल भेज देती हूँ।",
  "आपका बजट कितना है?",
];

const _phraseCache = new Map<string, Int16Array>();

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function cacheKey(text: string, language: string): string {
  return `${language}\u0000${normalize(text)}`;
}

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

export function getCachedPhrasePcm(text: string, language: string): Int16Array | null {
  return _phraseCache.get(cacheKey(text, language)) ?? null;
}
