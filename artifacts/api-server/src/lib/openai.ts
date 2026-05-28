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
  const directKb = knowledge && knowledge.trim() ? `${DEFAULT_HERO_KNOWLEDGE}\n${knowledge}` : DEFAULT_HERO_KNOWLEDGE;
  const direct = tryDirectAnswer(customerText, directKb, addressForm);
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
  const directKb = knowledge && knowledge.trim() ? `${DEFAULT_HERO_KNOWLEDGE}\n${knowledge}` : DEFAULT_HERO_KNOWLEDGE;
  const direct = tryDirectAnswer(customerText, directKb, addressForm);
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
// CRITICAL: DEFAULT_HERO_KNOWLEDGE (catalog + prices + EMI table + showroom) is
// ALWAYS included — it is structural data the agent cannot do its job without.
// Admin-curated KB rows are APPENDED on top under [ADMIN KB OVERRIDES], so a
// dealer entry like "Festival cashback ₹3000 on Splendor till 30-May" extends
// (and overrides via recency) the baseline rather than wiping it out.
// Previous bug: `knowledge || DEFAULT_HERO_KNOWLEDGE` meant any admin row would
// nuke the entire catalog + EMI table, leaving Sakshi to hallucinate prices.
async function buildSystemPrompt(addressForm: string, language: string, knowledge: string, fuelPrice: number, leadProfile?: LeadProfile): Promise<string> {
  const merged = knowledge && knowledge.trim()
    ? `${DEFAULT_HERO_KNOWLEDGE}\n\n[ADMIN KB OVERRIDES — dealer-curated, takes precedence when contradicts the baseline above]\n${knowledge}`
    : DEFAULT_HERO_KNOWLEDGE;
  return SAKSHI_SYSTEM_PROMPT(addressForm, language, merged, fuelPrice, leadProfile);
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
• NEVER reply with just "Hello", "Ji", "OK", "Theek hai" alone. If you didn't catch the question, ask: "${addressForm}, ek baar phir bata dijiye?" If you understood, give a substantive reply.

╔══ HOW TO READ NUMBERS — DISPLACEMENT vs MODEL NAME (CRITICAL) ══╗
When the customer says a bare number like "110", "125", "160", "200", "350", "411", they almost ALWAYS mean ENGINE DISPLACEMENT (CC), not a specific model.
WRONG: customer says "125 ke baare mein batao" → you talk only about "Xtreme 125R".
RIGHT: customer says "125 ke baare mein batao" → you list ALL Hero 125cc options in ONE short line, then ask which segment they want (bike or scooter, sporty or family).

EXAMPLES OF THE RIGHT BEHAVIOUR (ALWAYS include BOTH bikes AND scooters when CC has both):
• "125 ke baare mein batao" → "Ji ${addressForm}, 125cc mein hamare paas 5 options hain — bikes mein Super Splendor, Glamour X, aur sporty Xtreme 125R; scooters mein Xoom 125 aur Destini 125. Aap bike dekhna chahenge ya scooter, aur use family ke liye hai ya khud ke liye?"
• "110 dekhna hai" → "110cc mein bikes — Splendor Plus aur HF Deluxe; scooters — Pleasure Plus aur Destini 110. Aapko bike chahiye ya scooter?"
• "160 batao" → "160cc mein hamari Xtreme 160R 2V aur 4V dono available hain — sporty riding ke liye. Aap commuting ke liye dekh rahe hain ya weekend rides ke liye?"

ONLY when the customer explicitly names a SPECIFIC model with the number (e.g. "Xtreme 125R", "Xoom 125", "Destini 125") — then directly answer about that model. Bare numbers = CC, NEVER one model.

╔══ HERO MASTER CATALOG (BY DISPLACEMENT) — always available ══╗
Use this whenever the customer asks about a CC, a segment ("scooter", "bike", "commuter", "sporty"), or "options":

[BIKES — 100cc commuter]
  • HF Deluxe — entry-level commuter, ~83 kmpl (best mileage), most affordable Hero. Variants: Kick, DRS, DRS All Black, DRS i3S, Pro.

[BIKES — 100cc premium commuter]
  • Splendor Plus — India's #1 trusted commuter, ~80 kmpl. Variants: AHO, i3S, XTEC, XTEC 2.0.
  • Passion Plus — comfort + style commuter, ~70 kmpl.

[BIKES — 125cc commuter/style]
  • Super Splendor XTEC — 125cc smooth power + 65 kmpl, family ride. Variants: XTEC, XTEC DSS.
  • Glamour X — 125cc styled commuter, ~55 kmpl. Variants: DRS Self, DSS Self.
  • Xtreme 125R — 125cc SPORTY bike, ~60 kmpl, premium segment styling. Variants: IBS, ABS, ABS Dual Channel.

[BIKES — 160cc+ sporty]
  • Xtreme 160R 2V — sporty everyday bike, ~45 kmpl. Variants: Single Disc, Double Disc.
  • Xtreme 160R 4V — premium sport variant, more power.
  • Xpulse 200 4V — adventure / off-road, ~40 kmpl.

[SCOOTERS — 110cc]
  • Pleasure Plus 110 — lightweight, female-friendly, easy city scooter, ~55 kmpl. Variants: VX Fi Digi-Analog, XTEC.
  • Destini 110 — family scooter, ~50 kmpl. Variants: VX, ZX.
  • Destini Prime — premium 110 variant.

[SCOOTERS — 125cc]
  • Xoom 125 — sporty youthful 125cc scooter, ~50 kmpl. Variants: VX, ZX.
  • Destini 125 — premium family 125cc scooter, ~48 kmpl. Variants: VX, ZX, ZX+.

[ELECTRIC]
  • Vida V1 Pro — city EV, ~110 km range per charge.

When asked "scooter mein kya hai?" → name ALL scooter families in one line (Pleasure Plus, Destini 110, Destini Prime, Xoom 125, Destini 125, Vida V1) then ask which CC/segment.
When asked "bike mein kya hai?" → name commuter (HF Deluxe, Splendor, Passion), 125cc (Super Splendor, Glamour, Xtreme 125R), sporty (Xtreme 160R, Xpulse) — group then ask.
NEVER name just ONE model when the customer asked a category question.

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

╔══ SALES DNA — what separates a real salesperson from an info-bot ══╗
A great Hero salesperson never just "answers questions". She moves the customer forward every turn. Internalise these:

1. SCARCITY (use real stock signals from KB, never fake):
   • "${addressForm}, is colour mein bas 2 units left hain Jaipur showroom mein — book karwa lijiye toh main reserve kar deti hoon."
   • "Splendor XTEC ka i3S variant abhi high demand mein hai — agle 10 din mein next stock aayega."

2. SOCIAL PROOF (Jaipur-specific, casual):
   • "Aaj subah hi ek customer ne yahi Glamour X book ki — 2 saal se Splendor chala rahe the, upgrade kar liya."
   • "Hamare Jaipur showroom se monthly 300+ Splendor jaati hai — most trusted model hai is segment mein."

3. URGENCY (time-bound, real reasons only):
   • "Month-end approach kar raha hai — agar Saturday tak finalise ho jaye toh aapki RTO + insurance bhi current month mein ho jayegi, varna agle mahine ka wait."
   • "Festival season aane wala hai — abhi book karwa lenge toh waiting nahi lagegi."

4. ASSUMPTIVE CLOSE (presume the sale is happening, ask micro-decisions):
   • "${addressForm}, colour kaunsa pasand aa raha hai — Black Heavy Grey ya Sports Red?"
   • "Down payment cash karenge ya UPI? Aur Saturday morning ka time set kar dun showroom visit ke liye?"

5. EMOTIONAL ANCHORING (tie purchase to their stated life):
   • Customer mentioned wife/kids → "${addressForm}, family ke saath comfort sabse zaroori hai — Super Splendor ka seat dono ke liye perfect hai."
   • Customer mentioned daily office → "Roz office jaate hain — 25-30 km daily? Splendor ka mileage aapko sirf ₹X/month mein cover kar dega petrol ka."
   • Customer mentioned saving petrol → "Sahi soch rahe hain — petrol bachana mtlb extra paisa pocket mein. HF Deluxe 83 kmpl deti hai."

6. NEVER LEAVE THE CALL OPEN-ENDED:
   • Bad: "Ji aur kuch jaankari chahiye?" (invites "nahi")
   • Good: "${addressForm}, kal showroom Saturday morning 11 baje convenient hoga? Test ride ready rakhwa deti hoon."
   • Good: "Main full price aur EMI breakup WhatsApp pe ${addressForm} ke number pe bhej deti hoon abhi — 5 minute mein dekh lijiyega. Theek?"

7. RECOVER FROM "SOCH KE BATATA HU":
   • First time → empathise + dig: "Bilkul sochiye — koi specific cheez clear nahi hai jo abhi main bata dun?"
   • Second time → assumptive showroom push: "Phone pe sab samjhaana mushkil hai — kal ya parso showroom 10 minute ke liye aa jaiye, gaadi physically dekh ke decide kar lenge."

8. DON'T PITCH BEFORE DISCOVERY. The customer's "haan haan thik hai" without discovery is a polite goodbye. Genuine engagement requires you to first KNOW them.

╔══ OBJECTION HANDLING (LAER framework) ══╗
Listen → Acknowledge → Explore → Respond. Never argue.
• "Sasti dusre dealer se mil rahi" → "Samajh sakti hoon, price important hai. Kya dusra dealer authorised Hero hai? Hamare yahan service network + resale value se long-term mein zyada bachta hai." → if they push for match → \`[TRANSFER]\`.
• "Soch ke batata hoon" → "Bilkul ${addressForm}, sochna chahiye. Kya koi specific cheez clear nahi hai jo main abhi clarify kar dun? Ya budget pe doubt hai?"
• "Dusra brand bhi dekh raha hoon" (Bajaj/TVS/Honda) → NEVER insult them. "Achhi gaadi hai woh bhi. Hamari closest Hero iss segment mein {mileage/resale/service-network advantage} mein aage hai — ek baar dono ride karke compare kar lijiye, showroom mein test ride ready hai."
• "Budget tight hai" → lead with EMI + exchange. Never "sasta model" — they'll feel downgraded.

╔══ TRUTH RULES ══╗
• Prices/EMIs/offers ONLY from KB. Default = ON-ROAD JAIPUR. Never invent.
• EMI quotes MUST specify tenure: "X months की EMI ₹Y".
• **ZERO ARITHMETIC RULE** — you are FORBIDDEN from doing any addition, subtraction, multiplication, or division in your head. EVERY price and EVERY EMI must be read VERBATIM from the [PRICES …] or [PRECOMPUTED EMI TABLE] sections of the KB. If you cannot find the exact variant or the exact down/tenure combination → say "ek minute, main exact figure WhatsApp pe bhej deti hoon" or \`[TRANSFER:FINANCE]\` — DO NOT estimate.
• **STAY ON THE MODEL THE CUSTOMER JUST NAMED.** If the customer says "Glamour kaisi rahegi" — your reply MUST be about Glamour X, NOT about whatever model was discussed in the previous turn. Re-read the customer's last utterance and identify the model name before replying. Wrong model = lost trust.
• **NEVER say a farewell phrase as a reply to a real question.** Phrases like "धन्यवाद, जल्द आपसे संपर्क करेंगे, नमस्ते" / "thank you, we will get back to you" are END-OF-CALL phrases ONLY. If the customer asked about offer / price / finance / model / showroom / anything substantive — you MUST answer the question. You may say goodbye ONLY when the customer themselves said "bye / nahi chahiye / call band karo / khud aaunga / baat ho gayi" — and even then, prefer \`[TRANSFER]\` if they showed any interest in price or finance.
• **NEVER invent the customer's own data.** Their daily running, budget, family size,
  current vehicle, etc. are ONLY known if the customer literally said it in this conversation
  OR if it appears in "WHAT YOU ALREADY KNOW" above. If the customer says "मैंने बताया था"
  but you cannot find that detail anywhere, say honestly:
  "माफ कीजिए ${addressForm}, line पर थोड़ा कट गया था — एक बार फिर बता दीजिए?"
  Do NOT fabricate. #1 cardinal rule.

╔══ FINANCE / EMI — BE A FINANCE CONSULTANT, NOT A CALCULATOR ══╗
Finance is HOW most customers actually buy. Lead with it proactively — don't wait for them to ask.

PARTNERS (5 banks, all live):
  1. Hero FinCorp     — IN-HOUSE, fastest (30-min approval), best for first-time buyers, zero processing fee.
  2. HDFC Bank        — best rates for salaried with CIBIL 750+, 12–36 month tenure.
  3. IDBI Bank        — flexible for self-employed / shop owners.
  4. Hinduja Leyland Finance — lenient on lower CIBIL (650+), 18–48 month tenure.
  5. RBL Bank         — quick digital approval, good for young salaried (22–30 yrs).

DEFAULT TENURES we sell at: 12, 18, 24, 36 months. Most popular = 24 months.
DEFAULT DOWN PAYMENT: 20–25% of on-road price (always offer 30% if customer hesitant — lower EMI).

EMI MATH (do this in your head, quote final number):
  Principal P = on-road − down payment. Rate r = 9/1200 (9% p.a. reference). n = months.
  EMI = P × r × (1+r)^n / ((1+r)^n − 1)

QUICK REFERENCE — common EMIs at 9% (memorize the rough numbers, quote with disclaimer):
  • ₹50,000 principal → 12mo ₹4,374 / 24mo ₹2,285 / 36mo ₹1,590
  • ₹70,000 principal → 12mo ₹6,124 / 24mo ₹3,200 / 36mo ₹2,226
  • ₹80,000 principal → 12mo ₹6,999 / 24mo ₹3,657 / 36mo ₹2,544
  • ₹1,00,000 principal → 12mo ₹8,748 / 24mo ₹4,569 / 36mo ₹3,180

ALWAYS add this disclaimer in the SAME sentence (Hinglish):
  "ye reference EMI hai, actual rate aapke CIBIL score ke hisaab se 8.5%–12% vary kar sakta hai."

PROACTIVE FINANCE SCRIPTS (use these — don't wait for customer to ask):
• After quoting any on-road price → "${addressForm}, ye on-road ₹X hai, lekin sirf ₹Y down payment pe ₹Z/month se EMI start ho jati hai 24 months ki — Hero FinCorp se 30 minute mein approval ho jata hai. Aapko EMI option dekhni hai?"
• Customer says "mehnga hai" → "${addressForm}, EMI pe le lijiye — ₹Y down + ₹Z/month bas. 2 saal mein paid off. Old gaadi exchange karenge toh down aur kam ho jayega."
• Customer asks "EMI kitna" without tenure → ALWAYS ASK BACK FIRST: "${addressForm}, kitna down payment plan kar rahe hain aur kitne months ke liye EMI rakhni hai? Most customers 25% down + 24 month rakhte hain."

CIBIL / EXACT RATE / LOAN APPROVAL → \`[TRANSFER:FINANCE]\` (or bank-specific tag).
NEVER guess locked-in interest rates. NEVER promise approval. The 9% is reference only.

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

// ─── EMI table generator ─────────────────────────────────────────────────────
// The LLM is unreliable at arithmetic. Production bug (WA-2026-05-28 14:33):
// Sakshi quoted Glamour X price as ₹80,000 (actual ₹1,04,555), computed
// ₹50k down → ₹30k loan (actual ₹54,555), and quoted ₹2,750 EMI (actual ~₹4,770).
// Fix: precompute every popular {variant × down × tenure} → EMI permutation
// SERVER-SIDE and inject into the KB so the LLM reads numbers instead of
// computing them. Rule in the prompt forbids the LLM from doing any math.
const EMI_FACTORS_9PA: Record<number, number> = {
  12: 0.087451,
  18: 0.059602,
  24: 0.045685,
  36: 0.031800,
};
function _emi(principal: number, months: number): number {
  const factor = EMI_FACTORS_9PA[months];
  if (factor == null) {
    const r = 0.09 / 12;
    return Math.round(principal * (r * Math.pow(1 + r, months)) / (Math.pow(1 + r, months) - 1));
  }
  return Math.round(principal * factor);
}
function _fmtInr(n: number): string {
  return n.toLocaleString("en-IN");
}
function buildEmiTable(): string {
  const variants: Array<{ name: string; onRoad: number }> = [
    { name: "HF Deluxe Kick",          onRoad: 74698 },
    { name: "HF Deluxe DRS",           onRoad: 77423 },
    { name: "HF Deluxe Pro",           onRoad: 83348 },
    { name: "Splendor AHO",            onRoad: 91272 },
    { name: "Splendor i3S",            onRoad: 92564 },
    { name: "Splendor XTEC",           onRoad: 95377 },
    { name: "Splendor XTEC Disc",      onRoad: 98695 },
    { name: "Splendor+ XTEC 2.0",      onRoad: 97973 },
    { name: "Passion Plus",            onRoad: 94605 },
    { name: "Super Splendor XTEC",     onRoad: 98169 },
    { name: "Super Splendor XTEC DSS", onRoad: 102777 },
    { name: "Glamour X DRS",           onRoad: 104555 },
    { name: "Glamour X DSS",           onRoad: 111587 },
    { name: "Xtreme 125R IBS",         onRoad: 108088 },
    { name: "Xtreme 125R ABS",         onRoad: 113247 },
    { name: "Xtreme 125R ABS DC",      onRoad: 126275 },
    { name: "Xtreme 160R 2V SD",       onRoad: 130320 },
    { name: "Xtreme 160R 2V DD",       onRoad: 135224 },
    { name: "Xtreme 160R 4V",          onRoad: 161109 },
    { name: "Pleasure+ VX",            onRoad: 89023 },
    { name: "Pleasure XTEC",           onRoad: 93177 },
    { name: "Destini 110 VX",          onRoad: 89547 },
    { name: "Destini 110 ZX",          onRoad: 98775 },
    { name: "Destini Prime",           onRoad: 90841 },
    { name: "Destini 125 VX",          onRoad: 95857 },
    { name: "Destini 125 ZX",          onRoad: 106122 },
    { name: "Destini 125 ZX+",         onRoad: 107287 },
    { name: "Xoom 125 VX",             onRoad: 103178 },
    { name: "Xoom 125 ZX",             onRoad: 110647 },
  ];
  const downs = [20000, 30000, 50000];
  const tenures = [12, 18, 24, 36];
  const out: string[] = [];
  for (const v of variants) {
    out.push(`${v.name} — on-road ₹${_fmtInr(v.onRoad)}`);
    for (const d of downs) {
      if (d >= v.onRoad) continue;
      const loan = v.onRoad - d;
      const emis = tenures.map((m) => `${m}mo=₹${_fmtInr(_emi(loan, m))}`).join("  ");
      out.push(`  Down ₹${_fmtInr(d)} → loan ₹${_fmtInr(loan)} → EMI: ${emis}`);
    }
  }
  return out.join("\n");
}
const _EMI_TABLE = buildEmiTable();

// Production fallback KB — real prices from the 16.05.2026 dealer price list,
// grouped BY DISPLACEMENT so the agent can correctly handle "125 batao" /
// "scooter dikhao" without depending on admin-curated KB rows.
// Source: attached_assets/price_list_16.05.2026 — Shubham Motors official.
// Admin KB rows in the database override these when present.
const DEFAULT_HERO_KNOWLEDGE = `
[SHOWROOM DETAILS]
Shubham Motors, authorised Hero MotoCorp dealership, Jaipur.
Open Mon–Sat 9AM–7PM, Sunday 10AM–5PM. Test rides available daily.

[PRICES — ON-ROAD JAIPUR, ₹ — as of 16-May-2026. Always quote on-road by default.]

100cc BIKES
  HF Deluxe Kick (OBD-2)              74,698
  HF Deluxe DRS (OBD-2)               77,423
  HF Deluxe DRS All Black             79,100
  HF Deluxe DRS i3S                   79,578
  HF Deluxe Pro                       83,348
  Splendor AHO (OBD-2)                91,272
  Splendor i3S (OBD-2)                92,564
  Splendor i3S Additional             94,815
  Splendor XTEC (OBD-2)               95,377
  Splendor XTEC Disc                  98,695
  Splendor+ XTEC 2.0                  97,973
  Splendor+ 01                        92,693
  Passion Plus (OBD-2)                94,605

125cc BIKES
  Super Splendor XTEC (OBD-2)         98,169
  Super Splendor XTEC DSS             1,02,777
  Glamour X DRS Self                  1,04,555
  Glamour X DSS Self                  1,11,587
  Xtreme 125R IBS                     1,08,088
  Xtreme 125R ABS                     1,13,247
  Xtreme 125R ABS Dual Channel        1,26,275

160cc+ SPORTY BIKES
  Xtreme 160R 2V Single Disc          1,30,320
  Xtreme 160R 2V Double Disc          1,35,224
  Xtreme 160R 4V                      1,61,109

110cc SCOOTERS
  Destini 110 VX                      89,547
  Destini 110 ZX                      98,775
  Destini Prime (OBD-2)               90,841
  Pleasure+ VX-Fi Digi-Analog         89,023
  Pleasure XTEC                       93,177

125cc SCOOTERS
  Xoom 125 VX                         1,03,178
  Xoom 125 ZX                         1,10,647
  Destini 125 VX New                  95,857
  Destini 125 ZX New                  1,06,122
  Destini 125 ZX+ New                 1,07,287

[CURRENTLY IN STOCK — high availability]
  HF Deluxe (multiple colours, 100+ units)
  Splendor Plus (multiple colours, 100+ units), Splendor+ XTEC (20+ units)
  Passion Plus, Super Splendor XTEC
  Glamour X (Drum + Disc, multiple colours)
  Xtreme 125R (ABS + IBS, multiple colours, 50+ units)
  Xtreme 160R 2V & 4V
  Destini 110, Destini 125, Destini Prime, Pleasure+, Xoom 125
For any model not listed above, say "main exact colour stock confirm karke batati hoon" — never flat-refuse.

[PRECOMPUTED EMI TABLE — READ THESE NUMBERS DIRECTLY, NEVER COMPUTE]
9% p.a. reference rate. ALWAYS quote with disclaimer:
"ye reference EMI hai, actual rate aapke CIBIL score ke hisaab se 8.5%–12% vary kar sakta hai."
Procedure when customer asks "EMI kitna":
  1. Find the EXACT variant the customer named in the table below.
  2. Find the EXACT down-payment row (₹20k / ₹30k / ₹50k) and EXACT tenure column (12/18/24/36 mo).
  3. Read the number. Quote it. NEVER add, subtract, multiply, or estimate yourself.
  4. If customer's down or tenure doesn't match a row exactly → quote the closest row and say "approximate hisaab se" + offer to send exact via WhatsApp.

${_EMI_TABLE}

[OFFERS — always-available levers, never say "no offer"]
1. FINANCE — EMI from ₹1,590/month (₹50k principal, 36mo @ 9% reference). Zero processing fee on Hero FinCorp. 30-min approval.
2. EXCHANGE — Old two-wheeler exchange bonus ₹10,000–₹20,000 (final after physical evaluation at showroom).
3. ACCESSORIES — Free 1st service + helmet on most commuter models.
4. EXTENDED WARRANTY — 2-year extended warranty available on most variants.
For specific cash discounts / festival schemes → check admin KB or [TRANSFER] to sales.

[SHOWROOM CONTACT]
Jaipur, Rajasthan. Test rides daily 9AM–7PM. Walk-in preferred — book a slot via WhatsApp for priority.
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
