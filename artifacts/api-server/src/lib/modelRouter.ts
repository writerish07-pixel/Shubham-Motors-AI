// Hybrid model router — cost-optimised reply generation.
//
// Three tiers, in order of cost:
//   Tier 0 — template/KB lookup (NO LLM call, ~0 tokens)
//            handles greetings, simple price queries, yes/no, hours, address.
//   Tier 1 — gpt-4o-mini  (cheap, default for normal conversation)
//   Tier 2 — gpt-4o       (premium, only for complex objections / negotiation /
//                           explicit competitor comparisons / hot-buy closing)
//
// Routing is done with cheap regex/keyword heuristics so we don't burn a
// classifier LLM call to decide which LLM to call.

import type { ConversationTurn } from "./openai";

export type ModelTier = "mini" | "premium";

// Complexity heuristics — if ANY hit, we promote to the premium model.
const PREMIUM_KEYWORDS_RE = new RegExp(
  [
    // Price/discount negotiation
    "discount", "kam karo", "kam karoge", "kam kar do", "sasta", "mehnga", "महंगा", "महंगी",
    "बहुत ज्यादा", "जादा है", "जयदा है", "best price", "final price", "negotiate", "मोलभाव",
    // Financing / EMI complexity
    "emi calculation", "down payment", "loan eligibility", "cibil", "interest rate",
    // Competitor comparison (Hero-vs-X)
    "bajaj", "tvs", "honda", "yamaha", "suzuki", "ktm", "royal enfield", "bullet",
    "vs ", " versus ", "compare karo", "comparison", "तुलना", "किसका better",
    // Hot-buy commitment signals
    "book kar", "booking karna", "confirm karta", "abhi le", "aaj le lenge",
    "final kar", "delivery kab", "registration kab",
    // Multi-criteria / specific specs
    "mileage aur power", "kitne ka aata", "टॉर्क", "torque", "bhp", "ground clearance",
    // Trade-in / exchange
    "exchange", "purani bike", "second hand", "trade",
  ].join("|"),
  "i"
);

// Pure-info questions answerable directly from KB without an LLM.
const PRICE_QUERY_RE = /(?:price|कीमत|दाम|kitne ka|kitne ki|kya rate|on[- ]?road|ex[- ]?showroom)/i;
const HOURS_QUERY_RE = /(?:timing|kab khulta|kab khulte|open|close|hours|शोरूम कब)/i;
const ADDRESS_QUERY_RE = /(?:address|पता|location|kahan hai|कहाँ है|कैसे आऊं|directions)/i;
const YESNO_RE = /^(?:haan|han|ji|yes|ok|okay|theek|sahi|nahi|no|nope)[\s.!?]*$/i;
const GREETING_RE = /^(?:hello|hi|namaste|namaskaar|namaskar|नमस्ते|jai mata di|salaam|salam)[\s.!?]*$/i;

export function classifyTurn(customerText: string, history: ConversationTurn[]): ModelTier {
  // Premium signals win regardless of turn position — a competitor comparison
  // or "final price?" in turn 1 still deserves the better model.
  if (PREMIUM_KEYWORDS_RE.test(customerText)) return "premium";

  // Long customer turn likely needs better reasoning.
  if (customerText.length > 220 || customerText.split(/\s+/).length > 40) return "premium";

  // Otherwise the cheap model is fine, including the very first turns.
  void history; // history reserved for future signals (e.g. repeated objection)
  return "mini";
}

// Tier-0 attempt: try to answer using only the KB string (already built by
// caller). Returns a complete reply string or null if no clean match.
// Keeps the same agent voice as the LLM ("…सर!" closer + follow-up question).
export function tryDirectAnswer(
  customerText: string,
  knowledge: string,
  addressForm: string
): string | null {
  const text = customerText.trim();
  if (!text) return null;

  // Greeting-only message
  if (GREETING_RE.test(text)) {
    return `नमस्ते ${addressForm}! बताइए, कौन सी Hero बाइक या स्कूटर में आपकी रुचि है?`;
  }

  // Pure yes/no with no model context — too ambiguous, let LLM handle
  if (YESNO_RE.test(text)) return null;

  // Showroom hours — prefer KB-sourced answer; fall back to known defaults.
  if (HOURS_QUERY_RE.test(text)) {
    const kbHours = findKbLineByPattern(knowledge, /timing|hours|open|close|खुलता|बजे/i);
    const body = kbHours
      ? stripCategoryPrefix(kbHours)
      : "शुभम मोटर्स सोमवार से शनिवार सुबह 9 से शाम 7 बजे, रविवार सुबह 10 से शाम 5 तक खुला रहता है";
    return `${body}. आप कब आना चाहेंगे ${addressForm}?`;
  }

  // Address — prefer KB if present.
  if (ADDRESS_QUERY_RE.test(text)) {
    const kbAddr = findKbLineByPattern(knowledge, /address|location|showroom|जयपुर|jaipur/i);
    const body = kbAddr
      ? stripCategoryPrefix(kbAddr)
      : "हमारा showroom जयपुर में है। मैं exact location WhatsApp पर भेज देती हूँ";
    return `${body}. क्या आज शाम का test ride book कर लूँ ${addressForm}?`;
  }

  // Direct model-name + price lookup — restricted to [PRICE] rows only so a
  // stock or FAQ line for the same model can't be returned as the "price".
  if (PRICE_QUERY_RE.test(text)) {
    const model = findModelInText(text, knowledge);
    if (model) {
      const line = findPriceLine(knowledge, model);
      if (line) {
        return `${stripCategoryPrefix(line)}. ${addressForm}, आज showroom आ कर देख लीजिए — colour भी choose कर सकते हैं?`;
      }
    }
  }

  return null;
}

function stripCategoryPrefix(line: string): string {
  return line.replace(/^\[[A-Z_]+\]\s*/i, "").trim();
}

function findKbLineByPattern(knowledge: string, pattern: RegExp): string | null {
  for (const line of knowledge.split("\n")) {
    if (pattern.test(line)) return line;
  }
  return null;
}

// Extract the first Hero model name from the customer text that also appears
// in the KB (so we don't false-match on random words).
function findModelInText(text: string, knowledge: string): string | null {
  const kbModels = new Set<string>();
  for (const line of knowledge.split("\n")) {
    const m = line.match(/^\[PRICE\]\s+([A-Z][A-Z0-9 .+\-/()]+):/i);
    if (m && m[1]) kbModels.add(m[1].trim().toUpperCase());
  }
  // Common model keywords to detect in customer text (normalised)
  const HINTS = [
    "splendor", "हीरो स्प्लेंडर", "स्प्लेंडर",
    "passion", "पैशन",
    "glamour", "ग्लैमर",
    "hf deluxe", "एचएफ", "hf-dlx",
    "xtreme", "एक्सट्रीम",
    "xpulse", "एक्सपल्स",
    "destini", "डेस्टिनी",
    "pleasure", "प्लेज़र",
    "maestro", "मेस्ट्रो",
    "vida", "विडा",
  ];
  const lower = text.toLowerCase();
  for (const h of HINTS) {
    if (lower.includes(h)) {
      // Try to find the closest KB entry
      const upper = h.toUpperCase();
      for (const m of kbModels) {
        if (m.includes(upper.replace(/^हीरो\s+/, "").toUpperCase())) return m;
      }
      // Fallback: return raw hint if no KB match
      return h;
    }
  }
  return null;
}

// Only matches against [PRICE] rows so we never quote a stock-availability or
// FAQ line as if it were the price.
function findPriceLine(knowledge: string, model: string): string | null {
  const upper = model.toUpperCase();
  for (const line of knowledge.split("\n")) {
    if (!/^\[PRICE\]/i.test(line)) continue;
    if (line.toUpperCase().includes(upper)) return line;
  }
  return null;
}
