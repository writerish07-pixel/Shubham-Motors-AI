// Hybrid model router — cost-optimised reply generation.
//
// Three tiers, in order of cost:
//   Tier 0 — template/KB lookup (NO LLM call, ~0 tokens)
//            handles greetings, simple price queries, yes/no, hours, address.
//   Tier 1 — gpt-4o-mini  (cheap, default for normal conversation)
//   Tier 2 — gpt-4o       (premium, only for complex objections / negotiation /
//                           explicit competitor comparisons / hot-buy closing)

import type { ConversationTurn, DiscoverySignals } from "./openai";
import {
  FINANCE_PARTNERS_LIST,
  formatEmiQuote,
  parseAnnualRate,
  parseDownPayment,
  parseTenureMonths,
  resolveModelOnRoad,
} from "./emiQuote";
import { dealerConfig } from "./dealerConfig";
import {
  normalizeProductStt,
  isCruiseControlQuestion,
  mentionsGlamour,
  isFeatureAvailabilityQuestion,
} from "./sttProductFix";

export type ModelTier = "mini" | "premium";

// ─────────────────────────────────────────────────────────────────────────────
// STT alias correction. Sarvam often mishears Hero model names. We normalise
// the customer text BEFORE both the direct-answer router and the LLM see it
// so Sakshi never gets confused by spelling drift.
// ─────────────────────────────────────────────────────────────────────────────
const STT_ALIASES: Array<[RegExp, string]> = [
  [/jan\s+prakash/gi, "Gyan Prakash"],
  [/jian\s+prakash/gi, "Gyan Prakash"],
  [/जूम/g, "Xoom"],
  // Splendor variants
  [/\bsplender\b/gi, "Splendor"],
  [/\bsplendar\b/gi, "Splendor"],
  [/स्प्लेंडर/g, "Splendor"],
  // Xtreme
  [/\bextreme\b/gi, "Xtreme"],
  [/\bx[- ]?treme\b/gi, "Xtreme"],
  [/एक्सट्रीम/g, "Xtreme"],
  // Xpulse
  [/\bex[- ]?pulse\b/gi, "Xpulse"],
  [/\bexpulse\b/gi, "Xpulse"],
  [/एक्सपल्स/g, "Xpulse"],
  // Glamour
  [/\bglamor\b/gi, "Glamour"],
  [/ग्लैमर/g, "Glamour"],
  // Destini
  [/\bdestiny\b/gi, "Destini"],
  [/\bdestini\b/gi, "Destini"],
  [/डेस्टिनी/g, "Destini"],
  // Passion
  [/\bpashan\b/gi, "Passion"],
  [/पैशन/g, "Passion"],
  // Pleasure
  [/\bpleasur\b/gi, "Pleasure"],
  [/प्लेज़र/g, "Pleasure"],
  [/प्लेजर/g, "Pleasure"],
  // Karizma
  [/\bcarisma\b/gi, "Karizma"],
  [/\bkarisma\b/gi, "Karizma"],
  // HF Deluxe
  [/\bhf[- ]?delux\b/gi, "HF Deluxe"],
  [/\bach[- ]?ef\b/gi, "HF"],
];

export function correctStt(text: string): string {
  let t = text;
  for (const [re, rep] of STT_ALIASES) t = t.replace(re, rep);
  return normalizeProductStt(t);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier classifier — promotes to premium model only when needed.
// ─────────────────────────────────────────────────────────────────────────────
const PREMIUM_KEYWORDS_RE = new RegExp(
  [
    "discount", "kam karo", "kam karoge", "kam kar do", "sasta", "mehnga", "महंगा", "महंगी",
    "बहुत ज्यादा", "जादा है", "जयदा है", "best price", "final price", "negotiate", "मोलभाव",
    "emi calculation", "down payment", "loan eligibility", "cibil", "interest rate",
    "bajaj", "tvs", "honda", "yamaha", "suzuki", "ktm", "royal enfield", "bullet",
    "vs ", " versus ", "compare karo", "comparison", "तुलना", "किसका better",
    "book kar", "booking karna", "confirm karta", "abhi le", "aaj le lenge",
    "final kar", "delivery kab", "registration kab",
    "mileage aur power", "kitne ka aata", "टॉर्क", "torque", "bhp", "ground clearance",
    "cruise control", "cruise", "glamour", "क्रूज", "संट्रो",
    "exchange", "purani bike", "second hand", "trade",
  ].join("|"),
  "i"
);

const PRICE_QUERY_RE = /(?:price|कीमत|दाम|kitne ka|kitne ki|kya rate|on[- ]?road|ex[- ]?showroom|कितने|kitna|kitne)/i;
const VARIANT_QUERY_RE = /(?:variant|variants|कौन सी|kaunsi|kaun si|model|वेरिएंट|version)/i;
const FEATURE_QUERY_RE = /(?:feature|features|specs|mileage|माइलेज|engine|cc|warranty|वारंटी|cruise|क्रूज|centro|संट्रो|control|कंट्रोल)/i;
const HOURS_QUERY_RE = /(?:timing|kab khulta|kab khulte|open|close|hours|शोरूम कब)/i;
// "pata"/"पता" is a homonym: पता = address, BUT "pata karna/lagana/chalana" = to find out.
// FIND_OUT_RE catches the "find out / inquire" sense so it never triggers the address reply.
const FIND_OUT_RE = /(?:पता|pata)\s*(?:करन|कर\b|लग|चल|karn|kar\b|laga|chal)/i;
// Address intent in the ADDRESS sense only. "kahan/कहाँ" is matched ONLY with a
// place cue (showroom/dealer/shop) so "Xoom kahan hai?" routes to model lookup, not address.
const ADDRESS_QUERY_RE = new RegExp(
  [
    "address", "location", "directions",
    "रास्ता", "raasta", "rasta",
    "कैसे आऊं", "kaise aau",
    "पता\\s*(?:क्या|बता|भेज|दे|दो)", "pata\\s*(?:kya|bata|bhej|de|do)",
    "(?:showroom|dealer|shop|store|दुकान|शोरूम)\\s*(?:ka|ki|का|की)?\\s*(?:पता|pata|address)",
    "(?:showroom|dealer|shop|store|शोरूम)\\s*(?:kahan|कहाँ)",
    "(?:kahan|कहाँ)\\s*(?:hai|par|pe|है|पर|पे)?\\s*(?:showroom|dealer|shop|store|शोरूम)",
  ].join("|"),
  "i",
);
const YESNO_RE = /^(?:haan|han|ji|yes|ok|okay|theek|sahi|nahi|no|nope)[\s.!?]*$/i;
const GREETING_RE = /^(?:hello|hi|namaste|namaskaar|namaskar|नमस्ते|jai mata di|salaam|salam)[\s.!?]*$/i;

/** balanced (default) allows gpt-4o on negotiate/competitor turns within the ₹4/min cap. */
export function costMode(): "strict" | "balanced" | "quality" {
  const m = (process.env.COST_MODE ?? "balanced").toLowerCase();
  if (m === "quality" || m === "strict") return m;
  return "balanced";
}

export function classifyTurn(customerText: string, history: ConversationTurn[]): ModelTier {
  const mode = costMode();
  if (mode === "strict") return "mini";
  if (mode === "quality") return "premium";
  if (PREMIUM_KEYWORDS_RE.test(customerText)) return "premium";
  if (customerText.length > 220 || customerText.split(/\s+/).length > 40) return "premium";
  void history;
  return "mini";
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier-0 direct answer — operates on the new `[MODELS] Hero <name>: ...`
// knowledge format. Returns a complete reply (Sakshi voice + follow-up
// question) or null if it can't confidently answer.
// ─────────────────────────────────────────────────────────────────────────────
export function tryDirectAnswer(
  customerText: string,
  knowledge: string,
  addressForm: string,
  ctx?: { signals?: DiscoverySignals; history?: ConversationTurn[] },
): string | null {
  const text = correctStt(customerText.trim());
  if (!text) return null;
  const signals = ctx?.signals;

  if (GREETING_RE.test(text)) {
    return `नमस्ते ${addressForm}! बताइए, कौन सी Hero बाइक या स्कूटर में आपकी रुचि है?`;
  }
  if (YESNO_RE.test(text)) return null;

  const dealer = dealerConfig();
  if (HOURS_QUERY_RE.test(text)) {
    return `${dealer.name} ${dealer.hours} खुला रहता है. आप कब आना चाहेंगे ${addressForm}?`;
  }
  if (ADDRESS_QUERY_RE.test(text) && !FIND_OUT_RE.test(text)) {
    return `हमारा showroom ${dealer.address} है ${addressForm}, मैं exact location WhatsApp पर अभी भेज देती हूँ. क्या आज शाम का test ride book कर लूँ?`;
  }

  const historyText = (ctx?.history ?? []).map((h) => h.content).join(" ");
  const glamourCtx = mentionsGlamour(text) || mentionsGlamour(historyText) || /glamour/i.test(signals?.interestedModel ?? "");

  if (isCruiseControlQuestion(text) || (glamourCtx && isFeatureAvailabilityQuestion(text) && /control|cruis|centro|संट्रो|क्रूज/i.test(text))) {
    return `Glamour X DSS variant mein cruise control hai — DRS variant mein nahi hota. Highway ride comfortable rehti hai. Aap DSS dekhna chahenge ya DRS?`;
  }

  if (glamourCtx && (isFeatureAvailabilityQuestion(text) || FEATURE_QUERY_RE.test(text))) {
    return `Glamour X 125cc styled commuter hai — DSS variant mein cruise control milta hai, on-road Jaipur mein lagbhag ek lakh se upar. DRS ya DSS — kaun sa variant dekh rahe hain?`;
  }

  if (/(?:taxi|commercial|टैक्सी|कमर्शियल).*(?:number|regist|पंजी|रजिस्ट)|taxi.*(?:regist|number|plate)/i.test(text)) {
    return `Haan ${addressForm}, Hero bikes par commercial ya taxi registration RTO rules ke hisaab se ho sakta hai — commercial insurance alag lagta hai. Kaun sa model aur kis city mein chalayenge? Humara RTO desk paperwork sambhal leta hai.`;
  }

  if (/\bBH\b.*(?:number|series|plate|रजिस्ट)|bharat\s*series|भारत\s*सीरीज/i.test(text)) {
    return `BH series registration eligible customers ke liye available hai ${addressForm} — jo do alag states mein rehte ya kaam karte hain. Documents RTO pe depend karte hain; hum guide kar dete hain. Aap salaried hain ya business?`;
  }

  // Finance / EMI — list all banks; use customer's down payment @ 9% reference.
  if (/\bfinance\b|\bfinancing\b|\bemi\b|\bloan\b|किस्त|फाइनेंस|लोन|down\s*payment|डाउन|finance\s*option/i.test(text)) {
    const down = parseDownPayment(text);
    const months = parseTenureMonths(text) ?? 24;
    const rate = parseAnnualRate(text) ?? 0.09;
    const modelHint = signals?.interestedModel ?? "";
    const resolved = resolveModelOnRoad(text + " " + historyText, modelHint);

    if (down && resolved) {
      return formatEmiQuote(resolved.model, resolved.onRoad, down, months, rate);
    }

    if (/kitne\s*(mahine|month|मही)|tenure|duration/i.test(text) && ctx?.history?.length) {
      const lastAgent = [...ctx.history].reverse().find((h) => h.role === "assistant" && !/^\s*\[TRANSFER/i.test(h.content));
      if (lastAgent?.content.match(/₹[\d,]+/)) {
        return `जो ई एम आई मैंने अभी बताई थी — वो ${months} महीने की रेफरेंस ई एम आई है, नौ प्रतिशत पर। असल रेट आपके सिबिल पर साढ़े आठ से बारह प्रतिशत हो सकता है। ${FINANCE_PARTNERS_LIST}`;
      }
    }

    // Active finance — customer already asked; never skip to price-only monologue.
    if (signals?.financeInterest || /finance|financing|option/i.test(text)) {
      if (resolved) {
        const emi24 = formatEmiQuote(resolved.model, resolved.onRoad, 25000, 24, rate);
        return `${FINANCE_PARTNERS_LIST} ${emi24} आप कितना डाउन पेमेंट दे सकते हैं?`;
      }
      const vehicle = signals?.segment?.startsWith("scooter") ? "स्कूटर" : "बाइक";
      return `${FINANCE_PARTNERS_LIST} कौन सा ${vehicle} फाइनल है और कितना डाउन पेमेंट प्लान है — मैं चौबीस और छत्तीस महीने की ई एम आई बताऊँगी।`;
    }
  }

  // Model lookup — find which KB model the customer is asking about
  const modelEntry = findModelEntry(text, knowledge);
  if (!modelEntry) return null;

  const isPriceQ = PRICE_QUERY_RE.test(text);
  const isVariantQ = VARIANT_QUERY_RE.test(text);
  const isFeatureQ = FEATURE_QUERY_RE.test(text);

  if (isPriceQ) {
    const range = extractOnRoadRange(modelEntry.body);
    if (range) {
      return `${modelEntry.title} की on-road Jaipur price ${range} है ${addressForm}. कितने variant हैं उसमें से कौन सा देखना चाहेंगी — मैं detail भेज दूँ?`;
    }
  }
  if (isVariantQ) {
    const variants = extractVariantList(modelEntry.body);
    if (variants.length) {
      const list = variants.slice(0, 3).map(v => `${v.name} (₹${v.onRoad.toLocaleString("en-IN")})`).join(", ");
      const extra = variants.length > 3 ? `और भी ${variants.length - 3} variant हैं` : "";
      return `${modelEntry.title} में ${variants.length} variant available हैं — ${list}${extra ? ", " + extra : ""}. इनमें से कौन सा आपके लिए suit करेगा ${addressForm}?`;
    }
  }
  if (isFeatureQ) {
    const engine = matchLine(modelEntry.body, /^Engine:\s*(.+)$/m);
    const warranty = matchLine(modelEntry.body, /^Warranty:\s*(.+)$/m);
    if (engine) {
      const parts = [engine ? `Engine ${engine}` : null, warranty ? `warranty ${warranty}` : null].filter(Boolean);
      return `${modelEntry.title} में ${parts.join(", ")}. आप test ride के लिए कब आ सकेंगी ${addressForm}?`;
    }
  }

  return null;
}

interface ModelEntry { title: string; body: string }

function findModelEntry(text: string, knowledge: string): ModelEntry | null {
  // Each KB entry in the assembled string looks like:
  //   [MODELS] Hero Xoom 125: Hero Xoom 125 — Shubham Motors Jaipur ... \n ...
  // Entries are separated by single newlines but the content itself contains
  // newlines, so we split on the `[MODELS] ` prefix instead.
  const chunks = knowledge.split(/\n?\[MODELS\]\s+/i).filter(Boolean);
  const entries: ModelEntry[] = [];
  for (const c of chunks) {
    const m = c.match(/^([^:]+):\s*([\s\S]+?)(?=\n\[[A-Z_]+\]\s|$)/);
    if (m) entries.push({ title: m[1].trim(), body: m[2].trim() });
  }
  if (!entries.length) return null;

  const lower = text.toLowerCase();

  // Score each entry by how many distinctive tokens from its title appear in the text.
  let best: { entry: ModelEntry; score: number } | null = null;
  for (const e of entries) {
    const tokens = e.title.toLowerCase().replace(/^hero\s+/, "").split(/[\s+/]+/).filter(t => t.length >= 2);
    let score = 0;
    for (const t of tokens) {
      if (lower.includes(t)) score += t.length >= 4 ? 2 : 1;
    }
    if (score > 0 && (!best || score > best.score)) best = { entry: e, score };
  }
  return best?.entry ?? null;
}

function extractOnRoadRange(body: string): string | null {
  const m = body.match(/On-road Jaipur range:\s*(.+)$/m);
  if (m) return m[1].trim();
  // Single-variant entry — look for first "On-road Jaipur ₹X" line
  const single = body.match(/On-road Jaipur\s*(₹[\d,]+)/);
  return single ? single[1] : null;
}

function extractVariantList(body: string): Array<{ name: string; onRoad: number }> {
  const out: Array<{ name: string; onRoad: number }> = [];
  const re = /•\s+([^:]+):\s+Ex-showroom\s+₹[\d,]+\s+\|\s+RTO\s+₹[\d,]+\s+\|\s+Insurance\s+₹[\d,]+\s+\|\s+On-road Jaipur\s+₹([\d,]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out.push({ name: m[1].trim(), onRoad: parseInt(m[2].replace(/,/g, ""), 10) });
  }
  return out;
}

function matchLine(body: string, re: RegExp): string | null {
  const m = body.match(re);
  return m ? m[1].trim() : null;
}
