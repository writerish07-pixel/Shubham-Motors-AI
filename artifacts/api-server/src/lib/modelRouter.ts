// Hybrid model router — cost-optimised reply generation.
//
// Three tiers, in order of cost:
//   Tier 0 — template/KB lookup (NO LLM call, ~0 tokens)
//            handles greetings, simple price queries, yes/no, hours, address.
//   Tier 1 — gpt-4o-mini  (cheap, default for normal conversation)
//   Tier 2 — gpt-4o       (premium, only for complex objections / negotiation /
//                           explicit competitor comparisons / hot-buy closing)

import type { ConversationTurn } from "./openai";

export type ModelTier = "mini" | "premium";

// ─────────────────────────────────────────────────────────────────────────────
// STT alias correction. Sarvam often mishears Hero model names. We normalise
// the customer text BEFORE both the direct-answer router and the LLM see it
// so Sakshi never gets confused by spelling drift.
// ─────────────────────────────────────────────────────────────────────────────
const STT_ALIASES: Array<[RegExp, string]> = [
  // Xoom often comes as "Zoom" / "जूम"
  [/\bzoom\b/gi, "Xoom"],
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
  return t;
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
    "exchange", "purani bike", "second hand", "trade",
  ].join("|"),
  "i"
);

const PRICE_QUERY_RE = /(?:price|कीमत|दाम|kitne ka|kitne ki|kya rate|on[- ]?road|ex[- ]?showroom|कितने|kitna|kitne)/i;
const VARIANT_QUERY_RE = /(?:variant|variants|कौन सी|kaunsi|kaun si|model|वेरिएंट|version)/i;
const FEATURE_QUERY_RE = /(?:feature|features|specs|mileage|माइलेज|engine|cc|warranty|वारंटी)/i;
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

export function classifyTurn(customerText: string, history: ConversationTurn[]): ModelTier {
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
  addressForm: string
): string | null {
  const text = correctStt(customerText.trim());
  if (!text) return null;

  if (GREETING_RE.test(text)) {
    return `नमस्ते ${addressForm}! बताइए, कौन सी Hero बाइक या स्कूटर में आपकी रुचि है?`;
  }
  if (YESNO_RE.test(text)) return null;

  if (HOURS_QUERY_RE.test(text)) {
    return `Shubham Motors सोमवार से शनिवार सुबह 9 से शाम 7 बजे तक, और रविवार सुबह 10 से शाम 5 तक खुला रहता है. आप कब आना चाहेंगे ${addressForm}?`;
  }
  if (ADDRESS_QUERY_RE.test(text) && !FIND_OUT_RE.test(text)) {
    return `हमारा showroom जयपुर में है ${addressForm}, मैं exact location WhatsApp पर अभी भेज देती हूँ. क्या आज शाम का test ride book कर लूँ?`;
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
