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

export function classifyTurn(customerText: string, history: ConversationTurn[]): ModelTier {
  if (PREMIUM_KEYWORDS_RE.test(customerText)) return "premium";
  if (customerText.length > 220 || customerText.split(/\s+/).length > 40) return "premium";
  void history;
  return "mini";
}
