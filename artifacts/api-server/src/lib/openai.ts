import OpenAI from "openai";
import { db } from "@workspace/db";
import { knowledgeTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { logger } from "./logger";
import { classifyTurn, tryDirectAnswer } from "./modelRouter";

// Model IDs — kept here so the Settings UI or env can swap them later.
const MODEL_MINI = process.env.OPENAI_MODEL_MINI ?? "gpt-4o-mini";
const MODEL_PREMIUM = process.env.OPENAI_MODEL_PREMIUM ?? "gpt-4o";

// Use Replit's managed OpenAI integration (no key required — proxied through Replit).
// Falls back to user-provided OPENAI_API_KEY only if integration env vars are missing.
const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

// ─── In-memory cache for KB context + fuel price ─────────────────────────────
// Both are re-read from DB on every single agent turn, which adds 200-500 ms
// of latency per reply on a typical KB. They change minutes-to-hours apart
// (admin edits), so a short TTL is safe. Cache is invalidated by KB write
// routes (see invalidateKnowledgeCache below) so admin edits show up instantly.
const KB_CACHE_TTL_MS = 60_000;
let _kbCache: { value: string; expiresAt: number } | null = null;
let _kbInflight: Promise<string> | null = null;
let _fuelCache: { value: number; expiresAt: number } | null = null;
let _fuelInflight: Promise<number> | null = null;

export function invalidateKnowledgeCache(): void {
  _kbCache = null;
  _fuelCache = null;
}

export async function buildKnowledgeContext(): Promise<string> {
  const now = Date.now();
  if (_kbCache && _kbCache.expiresAt > now) return _kbCache.value;
  if (_kbInflight) return _kbInflight;
  _kbInflight = (async () => {
    const items = await db.select().from(knowledgeTable)
      .where(and(eq(knowledgeTable.isActive, true), eq(knowledgeTable.requiresReview, false)));
    const value = items.length === 0 ? "" : items
      .map((i) => `[${i.category.toUpperCase()}] ${i.title}: ${i.content}`)
      .join("\n");
    _kbCache = { value, expiresAt: Date.now() + KB_CACHE_TTL_MS };
    return value;
  })();
  try { return await _kbInflight; }
  finally { _kbInflight = null; }
}

/**
 * Fetch the current Jaipur petrol price (₹/L) from the special KB row
 * `category='market', title='fuel_price_jaipur'`. Falls back to ₹107 if unset.
 * Admin updates this weekly via the Knowledge UI. Cached 5 min — price changes
 * daily at most, no need to re-query per turn.
 */
const FUEL_CACHE_TTL_MS = 5 * 60_000;
export async function getJaipurFuelPrice(): Promise<number> {
  const now = Date.now();
  if (_fuelCache && _fuelCache.expiresAt > now) return _fuelCache.value;
  if (_fuelInflight) return _fuelInflight;
  _fuelInflight = (async () => {
    try {
      const rows = await db.select().from(knowledgeTable)
        .where(and(
          eq(knowledgeTable.title, "fuel_price_jaipur"),
          eq(knowledgeTable.category, "market"),
          eq(knowledgeTable.isActive, true),
          eq(knowledgeTable.requiresReview, false),
        ))
        .orderBy(desc(knowledgeTable.updatedAt))
        .limit(1);
      const raw = rows[0]?.content?.trim() ?? "";
      const n = parseFloat(raw);
      const value = Number.isFinite(n) && n > 50 && n < 200 ? n : 107;
      _fuelCache = { value, expiresAt: Date.now() + FUEL_CACHE_TTL_MS };
      return value;
    } catch {
      return 107;
    }
  })();
  try { return await _fuelInflight; }
  finally { _fuelInflight = null; }
}

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Per-customer background passed in by the caller. Built from the `leads`
 * table + last call summary. Used by Sakshi to open warmly ("aapne pichli
 * baar Splendor pe interest dikhayi thi…"), avoid asking the same discovery
 * questions twice, and pitch the right model without starting from scratch.
 */
export interface LeadProfile {
  /** Display name to address them with ("Rishabh ji"). */
  name?: string;
  /** Model the customer previously showed strongest interest in (e.g. "Splendor Plus"). */
  interestedModel?: string | null;
  /** Free-text notes captured by the team or self-learning (family, current bike, budget, occupation). */
  notes?: string | null;
  /** One-line outcome of the previous call, if any. */
  lastCallSummary?: string | null;
  /** Lead status from CRM — "hot" / "warm" / "thinking" / "new". */
  status?: string | null;
}

function formatLeadProfile(p?: LeadProfile): string {
  if (!p) return "";
  const lines: string[] = [];
  if (p.interestedModel) lines.push(`• Previously interested in: ${p.interestedModel}`);
  if (p.notes && p.notes.trim()) lines.push(`• Notes from past interactions: ${p.notes.trim()}`);
  if (p.lastCallSummary && p.lastCallSummary.trim()) lines.push(`• Last call summary: ${p.lastCallSummary.trim()}`);
  if (p.status && p.status !== "new") lines.push(`• CRM status: ${p.status}`);
  if (lines.length === 0) return "";
  return `\n╔══ WHAT YOU ALREADY KNOW ABOUT THIS CUSTOMER ══╗\n${lines.join("\n")}\n• Use ONLY to personalise — never invent details beyond what is listed here.\n• Reference it naturally in the FIRST 1–2 turns ("aapne pichli baar Splendor dekhi thi, kya wahi pasand aayi?"), not in every reply.\n╚════════════════════════════════════════════════╝`;
}

export async function generateAgentReply(
  customerText: string,
  conversationHistory: ConversationTurn[],
  leadName: string,
  language: string,
  leadProfile?: LeadProfile
): Promise<string> {
  const [knowledge, fuelPrice] = await Promise.all([buildKnowledgeContext(), getJaipurFuelPrice()]);

  const addressForm = leadName === "Sir" ? "सर" : `${leadName} जी`;
  // Unified prompt — same source of truth as generateAgentReplyStream so the
  // recording-fallback path (this function) and the live WS path can't drift.
  const systemPrompt = await buildSystemPrompt(addressForm, language, knowledge, fuelPrice, leadProfile);

  // ── Tier 0: try to answer directly from KB without any LLM call (saves 100%
  // of the tokens for greetings, hours, address, simple price lookups).
  const direct = tryDirectAnswer(customerText, knowledge || DEFAULT_HERO_KNOWLEDGE, addressForm);
  if (direct) {
    logger.info({ tier: "direct", chars: direct.length }, "Hybrid router → direct KB answer");
    return direct;
  }

  // ── Tier 1/2: pick mini vs premium model based on conversation complexity.
  const tier = classifyTurn(customerText, conversationHistory);
  const model = tier === "premium" ? MODEL_PREMIUM : MODEL_MINI;

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...conversationHistory.map((t) => ({ role: t.role, content: t.content })),
    { role: "user", content: customerText },
  ];

  const response = await openai.chat.completions.create({
    model,
    messages,
    max_tokens: 90,
    temperature: 0.7,
  });

  logger.info({ tier, model, inputLen: customerText.length }, "Hybrid router → LLM reply");
  return response.choices[0]?.message?.content ?? "जी बोलिए, मैं सुन रही हूँ।";
}

/**
 * Streaming variant: yields sentence-sized chunks of the reply as soon as the
 * LLM emits sentence-ending punctuation. Lets the caller pipeline each
 * sentence into TTS while the rest of the response is still being generated.
 *
 * Yields the SAME total text generateAgentReply would return, just split.
 * If the very first chunk starts with `[TRANSFER`, the entire response is
 * buffered and yielded as a single chunk (so the caller can parse the tag).
 */
export async function* generateAgentReplyStream(
  customerText: string,
  conversationHistory: ConversationTurn[],
  leadName: string,
  language: string,
  leadProfile?: LeadProfile
): AsyncGenerator<string, void, void> {
  const [knowledge, fuelPrice] = await Promise.all([buildKnowledgeContext(), getJaipurFuelPrice()]);
  const addressForm = leadName === "Sir" ? "सर" : `${leadName} जी`;

  // Tier 0 — direct KB answer, no LLM
  const direct = tryDirectAnswer(customerText, knowledge || DEFAULT_HERO_KNOWLEDGE, addressForm);
  if (direct) {
    logger.info({ tier: "direct", chars: direct.length }, "Hybrid router (stream) → direct KB answer");
    yield direct;
    return;
  }

  const tier = classifyTurn(customerText, conversationHistory);
  const model = tier === "premium" ? MODEL_PREMIUM : MODEL_MINI;

  const systemPrompt = await buildSystemPrompt(addressForm, language, knowledge, fuelPrice, leadProfile);

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...conversationHistory.map((t) => ({ role: t.role, content: t.content })),
    { role: "user", content: customerText },
  ];

  const stream = await openai.chat.completions.create({
    model,
    messages,
    // 70 tokens ≈ 2 short sentences (1 for English, 2–3 for Hindi). Keeping
    // replies short is the SINGLE biggest UX lever:
    //   • Customer hears a reply in ~2 s instead of ~15 s of monologue.
    //   • Barge-in actually works because there is barely anything to interrupt.
    //   • Total LLM time drops linearly with output tokens.
    // The system prompt already says "1–2 short sentences"; this enforces it
    // at the API level so the model can't drift into 5-sentence essays.
    max_tokens: 70,
    temperature: 0.7,
    stream: true,
  });

  let buf = "";
  let totalChars = 0;
  let isTransfer = false;
  // Flush on:
  //   • English sentence end "[.!?]" followed by whitespace (LLMs always
  //     add a space, so " " is reliable).
  //   • Bare Hindi "।" — no trailing-space requirement, because LLMs often
  //     emit "।" directly before the next word in Hindi output.
  //   • Hard newline anywhere.
  // Minimum sentence length is 6 chars (down from 12) so short openers like
  // "नमस्ते सर!" can flush IMMEDIATELY and start TTS pipelining — this was
  // the main mid-call latency cause: the first short sentence was re-buffered
  // and the customer heard nothing until the full reply was generated.
  const SENTENCE_END = /[.!?]\s|।|\n/;
  const MIN_SENTENCE_CHARS = 6;

  for await (const part of stream) {
    const delta = part.choices[0]?.delta?.content ?? "";
    if (!delta) continue;
    buf += delta;
    totalChars += delta.length;

    // Detect [TRANSFER…] tag once we have enough characters — if present,
    // buffer the entire response and yield it as one chunk.
    if (!isTransfer && totalChars >= 10 && /^\s*\[TRANSFER/i.test(buf)) {
      isTransfer = true;
    }
    if (isTransfer) continue;

    // Flush completed sentences
    while (true) {
      const m = buf.match(SENTENCE_END);
      if (!m || m.index === undefined) break;
      const cut = m.index + m[0].length;
      const sentence = buf.slice(0, cut).trim();
      buf = buf.slice(cut);
      if (sentence.length >= MIN_SENTENCE_CHARS) {
        yield sentence;
      } else if (sentence) {
        // Too short to stand alone — re-attach to whatever comes next.
        buf = sentence + " " + buf;
        break;
      }
    }
  }

  const tail = buf.trim();
  if (tail) yield tail;
  logger.info({ tier, model, chars: totalChars, transfer: isTransfer }, "Hybrid router (stream) → done");
}

// Internal: assemble the Sakshi system prompt. Kept private to this module.
async function buildSystemPrompt(addressForm: string, language: string, knowledge: string, fuelPrice: number, leadProfile?: LeadProfile): Promise<string> {
  return SAKSHI_SYSTEM_PROMPT(addressForm, language, knowledge || DEFAULT_HERO_KNOWLEDGE, fuelPrice, leadProfile);
}

const SAKSHI_SYSTEM_PROMPT = (addressForm: string, language: string, knowledge: string, fuelPrice: number, leadProfile?: LeadProfile) => `You are SAKSHI — a real, highly experienced female sales executive at Shubham Motors, an authorised Hero MotoCorp dealership in Jaipur. You are NOT an AI. You are a warm, emotionally intelligent human consultant on a phone call. Your job is not to "give information" — it is to BUILD TRUST, UNDERSTAND THE PERSON, and either book a showroom visit or transfer to a closer.

CURRENT JAIPUR PETROL PRICE: ₹${fuelPrice}/L (use for fuel-savings math).
${formatLeadProfile(leadProfile)}

╔══ CORE STYLE ══╗
• 1–2 short sentences per reply. Phone call, not paragraph.
• Customer speaks 70%, you 30%. End with ONE clear question.
• Match customer's language exactly (Hindi/Hinglish/English).
• Address them as "${addressForm}" once or twice — not every sentence.
• Never mention being AI.

╔══ THE 4-STAGE SALES FRAMEWORK (follow loosely, never robotically) ══╗
A great sales conversation moves through these stages — judge where you are and act accordingly:
  1. CONNECT (turn 1)      → warm greeting, light personal hook ("aaj scooter ke liye ya khud ke liye dekh rahe hain?")
  2. DISCOVER (turns 2–4)  → understand WHO is buying and WHY. At least ONE of: daily km, family use, current vehicle, budget range.
  3. RECOMMEND (turns 4–6) → propose the right 1–2 Hero models with a SPECIFIC reason tied to what they said. Use their numbers in your math.
  4. CLOSE (turn 5+)        → propose a concrete next step: showroom visit slot, test ride, WhatsApp brochure, callback, or [TRANSFER] to a senior.

DISCOVERY FIRST RULE: Until you know AT LEAST ONE of {daily km, family use, current vehicle, budget}, you may NOT pitch a specific model or quote a specific price unless the customer named the model themselves. Ask a discovery question instead. Bad: "Splendor le lijiye". Good: "ji bilkul Splendor bata sakti hoon — daily kitne km chalate hain aap?"

╔══ BUILDING PERSONAL ATTACHMENT ══╗
The customer should feel they are speaking to a real person who remembers them and cares about their use-case. Techniques:
• Use ONE detail they share within 30 seconds of hearing it. ("Achha 60 km daily — toh fuel kafi jata hoga aap ka.")
• If WHAT YOU ALREADY KNOW section has info, open with it: "${addressForm}, aapne pichli baar Splendor pe interest dikhayi thi — wahi continue karein ya kuch aur dekhna hai?"
• Mirror their energy. Excited customer → enthusiastic. Quiet customer → calm and patient.
• Use light human fillers occasionally: "achha", "samajh gayi", "bilkul", "haan ji", "perfect". Not every reply.
• Acknowledge family / responsibilities respectfully. ("Bachchon ke saath pillion comfort important hoga.")

╔══ OFFERS — NEVER, EVER SAY "KOI OFFER NAHI HAI" ══╗
"No offer" is a sale-killing answer. We ALWAYS have something to offer because financing, exchange, and free accessories are ALWAYS available:
• If KB has a specific cash discount / bank cashback → quote it EXACTLY (amount + bank + valid-till).
• If KB has no specific cash offer on the asked model → IMMEDIATELY pivot to one of these (do NOT say "no offer"):
   1. "Direct cash discount toh nahi, lekin ${addressForm} financing pe ₹X cashback aur free 1st service ka offer chal raha hai."
   2. "Cash offer nahi hai is model pe, but exchange pe aapki purani gaadi ka best value evaluate kar denge — usually ₹10,000–₹20,000 tak bonus mil jata hai."
   3. "Currently is model pe cash discount nahi, but EMI ₹X/month se start ho rahi hai with zero processing fee — woh batau?"
• If customer asks "exact discount kitna" and you genuinely don't have a KB-backed amount → \`[TRANSFER]\` to a sales person. Do NOT say "main check karke batati hoon" and leave them hanging — that's how the call ends.

╔══ PRODUCT INFO vs INVENTORY — TWO DIFFERENT QUESTIONS ══╗
• "Tell me about X / features / mileage / specs" = INFO question.
  → Always answer using general Hero brand knowledge. KB has prices; brand specs you can speak to even if not in KB. Do NOT volunteer stock status.
• "Available hai / stock / milegi" = INVENTORY question — ONLY then check KB.
  → If in KB → confirm + on-road price.
  → If not in KB → "मैं exact stock confirm करके बताती हूँ" + offer 7-10 day arrangement OR closest variant. NEVER flat-refuse.
• NEVER say "हमारे पास नहीं है" / "not available" for any Hero model — kills the sale.

╔══ KM/DAY → BIKE TIER (numeric, override style preferences) ══╗
• <30 km/day  → any tier; prioritise budget + customer preference.
• 30–60 km/day → mileage-lean: Splendor Plus, HF Deluxe, Passion Pro.
• 60–100 km/day → MILEAGE MANDATORY: Splendor Plus (80 kmpl) or HF Deluxe (83 kmpl). Quote fuel savings.
• >100 km/day → MILEAGE ONLY. Quote monthly fuel cost vs 50 kmpl alternative.
Math: monthly_fuel = (daily × 30 ÷ kmpl) × ₹${fuelPrice}. E.g. 100 km/day @ 83 kmpl = ₹${Math.round((3000/83)*fuelPrice).toLocaleString("en-IN")}/month vs scooter @ 50 kmpl ₹${Math.round((3000/50)*fuelPrice).toLocaleString("en-IN")}/month → saves ₹${Math.round(((3000/50)-(3000/83))*fuelPrice).toLocaleString("en-IN")}/month.

╔══ CLOSING TECHNIQUES (use the one that fits the moment) ══╗
Never end a call passively with "aur kuch jaankari chahiye?" — that just invites "nahi, dekh ke batata hoon".
• ASSUMPTIVE CLOSE: "${addressForm}, kal Saturday ko showroom convenient hoga ya Sunday subah? Test ride ready rakhwa deti hoon."
• ALTERNATIVE CLOSE: "Aap ${addressForm} WhatsApp pe full price list bhej doon ya direct showroom visit kar lein?"
• URGENCY CLOSE (only if KB explicitly says): "Ye scheme month-end tak hai — Saturday tak book ho jaye toh aapko full benefit milega."
• SOFT CLOSE (early stages): "Main aapko ek 2-minute brochure WhatsApp kar deti hoon, aap dekh ke decide kar lijiye — number same hai na?"
• SHOWROOM PUSH: Customer interested but hesitant on phone → "${addressForm}, phone pe sab samjhana mushkil hai — gaadi physically dekh ke aur baith ke 5 minute mein clear ho jayega. Kal showroom visit fix kar dein?"
By turn 5 you MUST have proposed at least ONE concrete next step. Don't ask "kuch aur jaankari chahiye" twice in a row — pivot to a close instead.

╔══ OBJECTION HANDLING (LAER framework) ══╗
Listen → Acknowledge → Explore → Respond. Never argue.
• "Sasti dusre dealer se mil rahi" → "Samajh sakti hoon, price important hai. Kya dusra dealer authorised Hero hai? Hamare yahan service network + resale value se long-term mein zyada bachta hai." → if they push for match → \`[TRANSFER]\`.
• "Soch ke batata hoon" → "Bilkul ${addressForm}, sochna chahiye. Kya koi specific cheez clear nahi hai jo main abhi clarify kar dun? Ya budget pe doubt hai?"
• "Dusra brand bhi dekh raha hoon" (Bajaj/TVS/Honda) → NEVER insult them. "Achhi gaadi hai woh bhi. Hamari closest Hero iss segment mein {mileage/resale/service-network advantage} mein aage hai — ek baar dono ride karke compare kar lijiye, showroom mein test ride ready hai."
• "Budget tight hai" → lead with EMI + exchange. Never "sasta model" — they'll feel downgraded.

╔══ TRUTH RULES ══╗
• Prices/EMIs/offers ONLY from KB. Default = ON-ROAD JAIPUR. Never invent.
• EMI quotes MUST specify tenure: "X months की EMI ₹Y".
• **NEVER invent the customer's own data.** Their daily running, budget, family size,
  current vehicle, etc. are ONLY known if the customer literally said it in this conversation
  OR if it appears in "WHAT YOU ALREADY KNOW" above. If the customer says "मैंने बताया था"
  but you cannot find that detail anywhere, say honestly:
  "माफ कीजिए ${addressForm}, line पर थोड़ा कट गया था — एक बार फिर बता दीजिए?"
  Do NOT fabricate. #1 cardinal rule.

╔══ FINANCE / EMI ══╗
Partners: HDFC Bank, Hero FinCorp, IDBI Bank, Hinduja Leyland Finance, RBL Bank.
EMI default: 9% p.a. Formula: P × r × (1+r)^n / ((1+r)^n − 1) where r=9/1200, n=months.
ALWAYS add disclaimer: "ये reference EMI है, actual rate aapke CIBIL score ke हिसाब से 8.5% से 12% तक vary कर सकता है."
Default bank = Hero FinCorp (in-house, fastest). PAN+Aadhaar required, approval 30 min.

╔══ TRANSFER PROTOCOL — TRIGGER AGGRESSIVELY, NEVER FAREWELL INSTEAD ══╗
Output ONLY the tag line, nothing else, when triggered. Triggers:
• Customer asks "sales वाले से बात कराओ" / "किसी se baat karwa do" / "manager से बात" / "human" / "real person" → \`[TRANSFER] customer asked to speak to sales\` IMMEDIATELY. Do NOT say goodbye — TRANSFER.
• Customer asks exact discount / offer amount you don't have in KB → \`[TRANSFER] customer wants exact offer details not in KB\`
• Customer wants negotiation / price match → \`[TRANSFER]\`
• Customer is angry / frustrated / says same complaint twice → \`[TRANSFER]\`
• [TRANSFER:FINANCE] <reason> → any finance partner (CIBIL check, loan approval, locked rate)
• [TRANSFER:FINANCE:HDFC] <reason> → specific bank (HDFC/HERO/IDBI/HINDUJA/RBL)

A TRANSFER is a WIN, not a failure. A farewell on a hot lead is a lost sale.

KNOWLEDGE BASE (your ONLY source of truth):
${knowledge}

Customer's language: ${language}`;

// Safety fallback only — used if the production KB is unexpectedly empty.
// Contains NO prices/EMIs so the agent never quotes stale numbers; it will
// transfer instead. The real stock list lives in the `knowledge` table.
const DEFAULT_HERO_KNOWLEDGE = `
[SHOWROOM DETAILS]
Shubham Motors, authorised Hero MotoCorp dealership, Jaipur.
Open Mon–Sat 9AM–7PM, Sunday 10AM–5PM. Test rides available daily.

[PRICING POLICY]
The stock list is being updated. Do NOT quote any price from memory.
For any price/EMI/variant question → TRANSFER to a sales executive.

[OFFERS — to be populated by admin in Knowledge base]
Until specific cash offers are listed here, pivot to these three ALWAYS-available levers:
1. FINANCE — EMI from ₹1,500/month (subject to tenure & CIBIL), zero processing fee on Hero FinCorp.
2. EXCHANGE — Old two-wheeler exchange bonus, typically ₹10,000–₹20,000 depending on condition (final figure after physical evaluation at showroom).
3. ACCESSORIES — Free first service + helmet on most models.
Never tell a customer "koi offer nahi hai" — that is not true; financing and exchange are always live.
`.trim();

export async function analyzeCallIntent(transcript: string): Promise<{
  intent: string;
  score: number;
  summary: string;
  followupDate: string | null;
  followupReason: string | null;
  language: string;
}> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `You are a sales call analyzer for Shubham Motors (Hero MotoCorp dealer).
Analyze the transcript and return JSON with:
- intent: "hot_buy" | "interested" | "thinking" | "future_date" | "not_interested" | "wrong_number" | "needs_info"
- score: 0-100 buying intent score
- summary: 1-2 sentence call outcome summary
- followupDate: ISO date string if customer mentioned a future time, else null
- followupReason: paraphrased reason to follow up, else null
- language: detected language code (hi, en, mr, etc.)
- familyInfo: any family members the customer mentioned (spouse, kids, ages, school/college, current vehicles) — store as short string for future cross-sell, else null
- preferredModel: specific Hero model the customer showed most interest in, else null
- objections: array of objection strings the customer raised (e.g. "price too high", "wants TVS comparison"), else []

Score guide: hot_buy=85-100, interested=60-80, thinking=40-60, future_date=50-70, needs_info=30-50, not_interested=0-20`,
      },
      { role: "user", content: `Transcript:\n${transcript}` },
    ],
    response_format: { type: "json_object" },
    temperature: 0.3,
  });

  try {
    return JSON.parse(response.choices[0]?.message?.content ?? "{}");
  } catch {
    logger.error("Failed to parse intent analysis JSON");
    return { intent: "needs_info", score: 30, summary: "Call completed", followupDate: null, followupReason: null, language: "hi" };
  }
}

/**
 * Self-learning v2 — extracts STRUCTURED, HIGH-SIGNAL items from a call:
 *   - agent_mistake  : agent said something the customer corrected
 *   - price_correction : KB price seems wrong based on call
 *   - new_objection  : objection pattern not in KB
 *   - missing_info   : customer asked something the agent couldn't answer
 *
 * All extracted items are inserted with isActive=false + requiresReview=true,
 * so they go to an admin review queue and NEVER reach the live agent until
 * a human approves them. Includes simple title-dedup against existing KB.
 */
export async function learnFromTranscript(transcript: string, outcome: string, source?: string): Promise<void> {
  try {
    // Pull existing KB titles for dedup (case-insensitive)
    const existing = await db.select({ title: knowledgeTable.title }).from(knowledgeTable);
    const existingTitles = new Set(existing.map((r) => r.title.toLowerCase().trim()));

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You audit Hero MotoCorp dealership sales calls. Extract ONLY high-signal items the sales team must know — NOT vague impressions.

Return JSON: { "items": [{
  "type": "agent_mistake" | "price_correction" | "new_objection" | "missing_info",
  "category": "faq" | "policy" | "objection" | "models" | "price" | "general",
  "title": "<short, specific, distinctive — max 80 chars>",
  "content": "<actionable fact + the correct response the agent should give next time>",
  "evidence": "<exact verbatim quote from transcript proving this>"
}] }

STRICT RULES:
• "agent_mistake": agent gave wrong info AND customer corrected, OR agent refused a valid question. Quote both lines.
• "price_correction": agent's price was disputed or contradicted in-call. Quote it.
• "new_objection": a NEW objection phrasing the agent struggled with. NOT generic ("customer wants discount").
• "missing_info": customer asked a specific question agent couldn't answer (specific model spec, scheme details).
• Skip impressions like "customer interested in X" or "customer wants mileage" — those have zero training value.
• Skip duplicates of well-known objections (price-match, EMI question, exchange).
• If nothing meets the bar, return {"items": []}. Empty is GOOD — quality over quantity.`,
        },
        { role: "user", content: `Transcript:\n${transcript}\n\nCall outcome: ${outcome}` },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
    });

    const parsed = JSON.parse(response.choices[0]?.message?.content ?? "{}");
    const items: Array<{ type: string; category: string; title: string; content: string; evidence?: string }> = parsed.items ?? [];

    const validCats = new Set(["faq", "policy", "objection", "models", "price", "general"]);
    let inserted = 0;
    for (const item of items) {
      if (!item.title || !item.content) continue;
      const tNorm = item.title.toLowerCase().trim();
      if (existingTitles.has(tNorm)) continue; // dedup
      const category = validCats.has(item.category) ? item.category : "general";
      await db.insert(knowledgeTable).values({
        title: item.title.slice(0, 120),
        category,
        content: `[${item.type}] ${item.content}`.slice(0, 1500),
        evidence: item.evidence ? item.evidence.slice(0, 800) : null,
        source: source ?? null,
        isActive: false,
        requiresReview: true,
      });
      existingTitles.add(tNorm);
      inserted++;
    }

    if (inserted > 0) {
      logger.info({ inserted, extracted: items.length, source }, "Self-learning v2 → queued for review");
    }
  } catch (err) {
    logger.error({ err }, "Error in self-learning from transcript");
  }
}
