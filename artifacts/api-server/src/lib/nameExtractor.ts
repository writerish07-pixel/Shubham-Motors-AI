// Extract a customer name from a short voice transcript.
// Customers reply to "आपका शुभ नाम बताइए?" in many shapes:
//   • Just the name:           "अमित"  /  "Amit"  /  "Amit Sharma"
//   • Hindi phrases:           "मेरा नाम अमित है"  /  "मैं अमित बोल रहा हूँ"  /  "अमित बोल रहा हूँ"
//   • English phrases:         "my name is Amit"  /  "I am Amit"  /  "this is Amit"
//   • Name + extra question:   "अमित। mujhe Splendor chahiye"
//
// Strategy: try regex patterns first, then fall back to a "looks like a 1-3
// word name-only response" heuristic. Reject obvious non-names (yes/no,
// greetings, digits, question words).

// Strong "name intent" patterns — match a phrase that clearly introduces a name
// and capture the following word(s). We then strip any trailing stopword/verb.
const PHRASE_PATTERNS: RegExp[] = [
  /(?:मेरा\s+(?:शुभ\s+)?नाम(?:\s+है)?)\s+([\u0900-\u097Fa-z][\u0900-\u097Fa-z]{1,20}(?:\s+[\u0900-\u097Fa-z]{1,20})?)/i,
  /(?:मैं|main)\s+([\u0900-\u097Fa-z][\u0900-\u097Fa-z]{1,20}(?:\s+[\u0900-\u097Fa-z]{1,20})?)\s+(?:बोल\s*रहा|बोल\s*रही|hoon|hu|बोलता|बोलती)/i,
  /(?:my\s+name\s+is|name\s+is|this\s+is|i\s+am|i'm)\s+([A-Za-z][A-Za-z]{1,20}(?:\s+[A-Za-z]{1,20})?)/i,
];

const STOPWORDS = new Set([
  // Affirmations / negations
  "haan", "han", "ji", "yes", "no", "nahi", "nahin", "theek", "sahi", "ok", "okay",
  "hello", "hi", "namaste", "namaskar", "नमस्ते", "हाँ", "हां", "जी", "नहीं",
  // Pronouns / intent words that frequently appear at the start of replies
  "mujhe", "mujhko", "mereko", "muje", "main", "mai", "hum", "ham", "tumhe", "aap", "aapko",
  "i", "me", "my", "we", "you", "your",
  // Verbs / common intent verbs that name regex could otherwise capture
  "chahiye", "lena", "lenge", "leni", "le", "lo", "interested", "want", "wanted", "looking",
  "buy", "buying", "book", "booking", "test", "ride", "see", "show", "tell", "know", "need",
  "batao", "bataiye", "bolo", "bol", "samajh", "samjha", "samjhao", "pata",
  "kya", "kaun", "kaisa", "kaisi", "kab", "kahan", "kitna", "kitni", "what", "who", "how", "when", "where",
  // Model names (must never be captured as a customer name)
  "splendor", "passion", "glamour", "destini", "pleasure", "xtreme", "xpulse",
  "vida", "maestro", "hf", "deluxe", "hero", "honda", "bajaj", "tvs", "yamaha", "suzuki",
  // Generic
  "sir", "madam", "maam", "bhai", "boss", "ji", "saab",
]);

export function extractCustomerName(text: string): string | null {
  if (!text) return null;
  const cleaned = text.trim();
  if (!cleaned) return null;

  // 1. Strong phrase pattern: "my name is X", "मेरा नाम X है", etc.
  for (const re of PHRASE_PATTERNS) {
    const m = cleaned.match(re);
    if (m && m[1]) {
      const cleaned1 = stripTrailingStopwords(m[1]);
      const name = cleanName(cleaned1);
      if (isPlausibleName(name)) return name;
    }
  }

  // 2. Bare-name fallback — ONLY if the reply is very short (1-2 words) and
  // every token passes the stopword filter. Anything longer must use a strong
  // pattern above. This prevents "mujhe Splendor chahiye" from being stored.
  const noPunct = cleaned.replace(/[.,!?]/g, "").trim();
  if (noPunct.length > 25) return null;
  if (/[?]/.test(cleaned)) return null;
  if (/\d/.test(noPunct)) return null;
  const words = noPunct.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 2) return null;
  for (const w of words) if (STOPWORDS.has(w.toLowerCase())) return null;

  const name = cleanName(noPunct);
  return isPlausibleName(name) ? name : null;
}

// Strip trailing intent verbs/stopwords from a captured chunk like
// "Amit interested" → "Amit"; "अमित बोल" → "अमित".
function stripTrailingStopwords(s: string): string {
  let parts = s.trim().split(/\s+/);
  while (parts.length > 1 && STOPWORDS.has(parts[parts.length - 1]!.toLowerCase())) {
    parts.pop();
  }
  return parts.join(" ");
}

function cleanName(s: string): string {
  // Title-case the latin parts; leave Devanagari as is
  return s.trim()
    .split(/\s+/)
    .map((w) => /^[a-z]/i.test(w) ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w)
    .join(" ")
    .slice(0, 40);
}

function isPlausibleName(name: string): boolean {
  if (!name) return false;
  if (name.length < 2 || name.length > 40) return false;
  const lower = name.toLowerCase();
  for (const sw of STOPWORDS) if (lower === sw) return false;
  // Must contain at least one letter (latin or devanagari)
  if (!/[a-z\u0900-\u097F]/i.test(name)) return false;
  return true;
}
