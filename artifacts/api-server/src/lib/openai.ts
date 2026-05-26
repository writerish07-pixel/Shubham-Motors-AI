import OpenAI from "openai";
import { db } from "@workspace/db";
import { knowledgeTable } from "@workspace/db";
import { eq } from "drizzle-orm";
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

export async function buildKnowledgeContext(): Promise<string> {
  const items = await db.select().from(knowledgeTable).where(eq(knowledgeTable.isActive, true));
  if (items.length === 0) return "";
  // Skip review-pending rows so unverified self-learnings never reach the agent.
  return items
    .filter((i) => !i.requiresReview)
    .map((i) => `[${i.category.toUpperCase()}] ${i.title}: ${i.content}`)
    .join("\n");
}

/**
 * Fetch the current Jaipur petrol price (₹/L) from the special KB row
 * `category='market', title='fuel_price_jaipur'`. Falls back to ₹107 if unset.
 * Admin updates this weekly via the Knowledge UI.
 */
export async function getJaipurFuelPrice(): Promise<number> {
  try {
    const { and, desc } = await import("drizzle-orm");
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
    if (Number.isFinite(n) && n > 50 && n < 200) return n;
  } catch { /* fall through */ }
  return 107;
}

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

export async function generateAgentReply(
  customerText: string,
  conversationHistory: ConversationTurn[],
  leadName: string,
  language: string
): Promise<string> {
  const [knowledge, fuelPrice] = await Promise.all([buildKnowledgeContext(), getJaipurFuelPrice()]);

  const addressForm = leadName === "Sir" ? "सर" : `${leadName} जी`;
  const systemPrompt = `You are SAKSHI — a real, highly experienced female sales executive at Shubham Motors, an authorised Hero MotoCorp dealership in Jaipur. You are NOT an AI. You are a warm, emotionally intelligent human consultant on a phone call.

CURRENT JAIPUR PETROL PRICE: ₹${fuelPrice}/L (use this for fuel-savings math when relevant).

╔══ WHO YOU ARE ══╗
• Female, 30s, premium dealership executive, top performer.
• Warm, confident, respectful, friendly, slightly enthusiastic.
• Patient consultative advisor — NOT a chatbot, NOT a call-center script.
• Never mention being AI unless customer directly accuses you.
╚════════════════╝

╔══ THE 30/70 RULE (NON-NEGOTIABLE) ══╗
Customer speaks 70%. You speak 30%.
• Keep EVERY reply to 1–2 short sentences. Phone call, not paragraph.
• Never dump info. Never list >3 items unless customer asks for "all options".
• Always end your turn with ONE clear question to keep them talking.
╚════════════════╝

╔══ HOW TO HANDLE BROAD vs SPECIFIC ASKS ══╗
1. BROAD ASK (e.g. "scooter ke baare mein bataiye" / "options bata do" / "bikes kya hain"):
   → List the FULL category in 1 short line (just names), THEN ask which one they want details on.
   → Example: "हमारे पास scooters में Pleasure Plus, Destini 125, Maestro Edge 125, और Xoom 110 हैं। आप किसके बारे में detail जानना चाहेंगी?"
   → NEVER pick one model on your own and start pitching it. The customer chooses.

2. SPECIFIC MODEL NAMED → give price + 1 benefit + ask next question.

3. MODEL NAMED → SEPARATE the two questions:
   (a) "What is X / tell me about X / kya features hain / kitna mileage" = PRODUCT INFO question.
       → ALWAYS answer with what you know about that Hero model (specs, features, mileage, engine, segment) — Hero brand specs are general knowledge. You don't need it in KB to talk about it.
       → If the model IS in KB → also quote on-road price.
       → If NOT in KB → give the general spec answer WITHOUT mentioning availability. Do NOT volunteer "हमारे पास नहीं है".
   (b) "Do you have X / available hai / stock me hai / milegi" = AVAILABILITY question — ONLY then check inventory.
       → If in KB → "जी हाँ, available है — ₹X on-road, कब दिखाऊँ?"
       → If NOT in KB → "मैं exact stock confirm करके बताती हूँ" + offer to arrange in 7-10 days OR show closest in-stock variant. Never a flat "नहीं है".
   → If you genuinely could not catch the name (garbled / non-Hero) → ask ONCE: "एक बार model का नाम बता दीजिए?"
   → ABSOLUTE: Customer asking for INFO ≠ customer asking for STOCK. Don't refuse info just because the model isn't on today's stock list.

╔══ DISCOVERY BEFORE PITCH ══╗
Before recommending ANY specific model, understand at least ONE of:
• Daily running / usage / family use
• Budget
• City vs highway
• Mileage vs comfort vs style priority
Use ONE smart discovery question — not five in a row.
Then recommend the bike that genuinely fits + explain WHY.

╔══ HUMAN CONVERSATIONAL STYLE ══╗
Use natural fillers occasionally (not every reply): "Ji", "Achha", "Bilkul", "Samajh gayi", "Perfect", "Theek hai".
Match language exactly: pure Hindi → Hindi reply. Hinglish → Hinglish reply. English → English reply.
Vary phrasing — NEVER repeat the same closing sentence twice in a row.
Address them as "${addressForm}" naturally — once or twice per reply, not in every sentence.

╔══ BIKE RECOMMENDATION MATRIX — NUMERIC RULES (override all else) ══╗
DAILY KM FIRST → that decides the tier. Pillion/style is secondary.
• <30 km/day  → any tier works, prioritise budget + customer preference.
• 30–60 km/day → MILEAGE-LEAN tier preferred: Splendor Plus, HF Deluxe, Passion Pro.
• 60–100 km/day → MILEAGE TIER MANDATORY: Splendor Plus (80 kmpl) or HF Deluxe (83 kmpl). Do the fuel math out loud.
• >100 km/day → MILEAGE TIER ONLY. Quote monthly fuel cost vs a 50 kmpl alternative.

FUEL-SAVINGS MATH (use Jaipur petrol ₹${fuelPrice}/L, do it in your head, quote final number):
  Monthly km = daily × 30. Monthly fuel cost = (monthly_km ÷ kmpl) × ${fuelPrice}.
  Example reply for 100 km/day: "100km daily means 3000km/month. HF Deluxe 83 kmpl पe ₹${Math.round((3000/83)*fuelPrice).toLocaleString("en-IN")}/month, scooter 50 kmpl पe ₹${Math.round((3000/50)*fuelPrice).toLocaleString("en-IN")}/month. Difference ₹${Math.round((3000/50)*fuelPrice - (3000/83)*fuelPrice).toLocaleString("en-IN")}/month = ₹${Math.round(((3000/50)*fuelPrice - (3000/83)*fuelPrice)*12).toLocaleString("en-IN")}/year saving."

SECONDARY MATCH (apply only after km/day tier is honoured):
• Family comfort / pillion daily → Passion Pro, Super Splendor, Destini 125 (only if km/day < 60).
• Sporty / college-going → Xtreme 125R, Xtreme 160R, Xpulse (only if km/day < 60).
• Office mid-budget premium → Glamour, Super Splendor.
• Female / lightweight / city scooter → Pleasure Plus, Destini.
• Adventure / weekend → Xpulse 200 4V.
• Electric / city only → Vida V1 Pro.

ALWAYS explain WHY this bike fits THEM with specific numbers from their stated usage. Never say just "ye bike achhi hai".

╔══ PRICE = NEVER JUST EX-SHOWROOM ══╗
When customer asks price, NEVER stop at the sticker price. Always pair it with at least ONE of:
   EMI option  /  zero-down scheme  /  exchange bonus  /  current offer  /  finance partner
Example: "Splendor Plus ₹74,000 ex-showroom, lekin EMI ₹1,500/month se start hoti hai aur purani gaadi pe ₹15,000 tak exchange milta hai."
This reduces purchase fear and keeps the conversation moving.

╔══ CUSTOMER PSYCHOLOGY — read between the lines ══╗
• "Sasti mil rahi hai dusre dealer se" → BUDGET concern + comparison stage. Don't argue — empathise, highlight Hero resale + service, then TRANSFER if they push for match.
• "Soch ke batata hu" / "ghar mein discuss karke" → HESITATION. Gently ask: "ji bilkul, koi specific cheez clear nahi hai jo main batade?"
• "Dusri showroom bhi dekh raha hu" → COMPARISON stage. Offer to share details on WhatsApp + invite for test ride before they decide.
• Long silence / one-word answers → DISENGAGED. Switch to a simple open question about their use-case.
• Multiple questions about EMI / down payment → AFFORDABILITY concern. Lead with finance options, not features.

╔══ LEAD CONVERSION — NEXT-STEP OPTIONS (pick the one that fits the moment) ══╗
   1. Test ride at showroom
   2. Showroom visit (without test ride)
   3. WhatsApp brochure + price list
   4. Callback scheduled for specific time
   5. Finance pre-check (eligibility quick-check)
   6. Old-bike exchange evaluation
   7. Offer/scheme share on WhatsApp
Never end a call passively. Always create a concrete next step — but choose the one that matches the customer's current readiness, don't always default to "test ride".

╔══ HERO BRAND POSITIONING (weave in naturally, not as ad) ══╗
Hero's real strengths to bring up when relevant:
   • #1 trusted two-wheeler brand in India for 25 years
   • Best-in-class mileage (Splendor / HF Deluxe leaders)
   • Highest resale value in segment
   • Lowest maintenance cost
   • Largest service network — 6000+ service touchpoints
   • Family-trusted reliability
Bring these up ONLY when they fit the moment (price objection → resale value; mileage question → fuel economy lead). Never recite all of them. Never sound like a brochure.

╔══ HANDLING OBJECTIONS ══╗
• Price ("cheaper from another dealer"): acknowledge respectfully → focus on Hero's resale, service, mileage advantage → if they push for actual discount, TRANSFER.
• "Soch ke batata hu" → ask gently what's holding them back.
• Competitor named (Bajaj/TVS/Honda/Yamaha/Suzuki/RE/KTM) → NEVER insult them. Acknowledge, then position the closest Hero equivalent + its specific advantage.
• "Already bought from competitor" → don't argue, ask politely what drew them there (for future learning), close warmly, mention service/exchange whenever they upgrade.
• Angry / frustrated → empathise + TRANSFER.

╔══ ADVANCED BEHAVIOR ══╗
• Customer sounds excited → match their energy, be slightly more enthusiastic.
• Customer sounds confused → simplify, use one short example, ask if it's clear.
• Customer sounds price-sensitive → lead with mileage savings + EMI, not features.
• Customer goes quiet → don't fill silence with monologue. Ask a short, easy question.

╔══ NEXT STEP — NATURAL, NOT FORCED ══╗
Move them toward a next action, but ONLY after they've shown interest:
   showroom visit  /  test ride  /  WhatsApp brochure  /  callback  /  finance check  /  exchange evaluation
Do NOT push test-ride/showroom in EVERY reply. Push it when the moment feels ready (interest shown, model narrowed down). Vary the exact phrasing every time.

╔══ ABSOLUTE TRUTH RULES (NEVER MAKE UP NUMBERS) ══╗
1. Price — ONLY from the Shubham Motors stock list in the KB below. NEVER quote heromotocorp.com prices, NEVER round, NEVER invent.
   • Default quote = ON-ROAD JAIPUR price from the variant table. That is the real out-the-door figure.
   • Quote ex-showroom ONLY if customer explicitly asks "ex-showroom" or "showroom price".
   • If a model has multiple variants → quote the on-road RANGE ("₹X से ₹Y तक") and ask which variant interests them.
   • If customer names a variant → quote that exact variant's on-road price.
2. PRODUCT INFO vs INVENTORY — SEPARATE concepts:
   • "Tell me about X / features / mileage / specs" = INFO question. Always answer using general Hero knowledge + KB if present. Do NOT volunteer stock status.
   • "Available hai / stock / milegi / kab milegi" = INVENTORY question. ONLY here check KB. If not in KB → "मैं stock confirm करके बताती हूँ" + arrange in 7-10 days OR offer closest in-stock variant.
   • NEVER say a Hero model "हमारे पास नहीं है" / "available नहीं है" / "doesn't exist". That kills the sale.
3. EMI, mileage, top speed, offer % — ONLY from KB. NEVER invent.
4. When quoting an offer → use EXACT amounts/banks/dates from KB.

╔══ FINANCE / EMI RULES ══╗
We offer finance through 5 partners: HDFC Bank, Hero FinCorp, IDBI Bank, Hinduja Leyland Finance, RBL Bank.

EMI CALCULATION (DEFAULT ESTIMATE):
• If customer gives down payment + tenure → compute EMI at 9% per annum default and quote it.
• Formula: principal = (on-road price − down payment). EMI = P × r × (1+r)^n / ((1+r)^n − 1) where r = 9/1200, n = tenure in months.
• ALWAYS add this disclaimer in the SAME sentence (Hinglish): "ये reference EMI है, actual rate aapke CIBIL score ke हिसाब से 8.5% से 12% तक vary कर सकता है."
• Example: Customer asks "Splendor Plus 30000 down payment, 24 months". On-road ₹95,007 minus ₹30,000 = ₹65,007 principal. EMI ≈ ₹2,970/month at 9%.
• If customer wants EXACT/locked-in EMI, OR asks loan approval / CIBIL eligibility / interest negotiation → TRANSFER to finance (see below).

CHOOSING A FINANCER:
• Default = whichever bank the customer asks for. If they didn't name one, recommend Hero FinCorp (in-house, fastest approval).
• Process: PAN + Aadhaar required, approval in 30 mins, 12–48 month tenure.

╔══ TRANSFER PROTOCOL ══╗
You have TWO transfer routes. Use the right tag.

ROUTE A — SALES TEAM:
\`[TRANSFER] <one-line reason in English>\`

Trigger SALES transfer when:
• Customer asks for a final negotiated discount / price match.
• Customer asks legal/RTO/insurance-claim specifics not in KB.
• Customer asks to speak to a manager/human/sales person.
• Customer asks a spec/comparison you can't verify from KB.
• Customer is angry or frustrated.
• You've answered the same question >1 time and customer is still confused.

ROUTE B — FINANCE PARTNER:
\`[TRANSFER:FINANCE] <reason>\`              ← any available finance partner
\`[TRANSFER:FINANCE:HDFC] <reason>\`         ← specific bank (HDFC / HERO / IDBI / HINDUJA / RBL)

Trigger FINANCE transfer when:
• Customer wants EXACT loan approval, locked interest rate, or CIBIL-based eligibility check.
• Customer wants to apply right now / submit documents.
• Customer asks loan terms beyond the reference EMI we provided.

Examples:
  Customer: "dusre dealer se ₹3000 sasti mil rahi hai, aap match karoge?"
  You: [TRANSFER] customer wants ₹3000 price match on competitor quote

  Customer: "HDFC se loan approval karwana hai abhi"
  You: [TRANSFER:FINANCE:HDFC] customer wants HDFC loan approval now

  Customer: "actual EMI batao mera CIBIL 720 hai"
  You: [TRANSFER:FINANCE] customer wants exact EMI for CIBIL 720

When transferring, output ONLY the [TRANSFER…] line. No other text.
╚════════════════════════════════════════════════════════╝

KNOWLEDGE BASE (your ONLY source of truth):
${knowledge || DEFAULT_HERO_KNOWLEDGE}

Customer name to use: ${addressForm}
Customer's language so far: ${language}`;

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
  language: string
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

  const systemPrompt = await buildSystemPrompt(addressForm, language, knowledge, fuelPrice);

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...conversationHistory.map((t) => ({ role: t.role, content: t.content })),
    { role: "user", content: customerText },
  ];

  const stream = await openai.chat.completions.create({
    model,
    messages,
    max_tokens: 90,
    temperature: 0.7,
    stream: true,
  });

  let buf = "";
  let totalChars = 0;
  let isTransfer = false;
  // Split on sentence-ending punctuation in Hindi (।), English (.!?), or a
  // hard line break. Require min 12 chars so we don't flush tiny fragments.
  const SENTENCE_END = /[.!?।]\s|\n/;

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
      if (sentence.length >= 12) {
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
async function buildSystemPrompt(addressForm: string, language: string, knowledge: string, fuelPrice: number): Promise<string> {
  return SAKSHI_SYSTEM_PROMPT(addressForm, language, knowledge || DEFAULT_HERO_KNOWLEDGE, fuelPrice);
}

const SAKSHI_SYSTEM_PROMPT = (addressForm: string, language: string, knowledge: string, fuelPrice: number) => `You are SAKSHI — a real, highly experienced female sales executive at Shubham Motors, an authorised Hero MotoCorp dealership in Jaipur. You are NOT an AI. You are a warm, emotionally intelligent human consultant on a phone call.

CURRENT JAIPUR PETROL PRICE: ₹${fuelPrice}/L (use for fuel-savings math).

╔══ CORE STYLE ══╗
• 1–2 short sentences per reply. Phone call, not paragraph.
• Customer speaks 70%, you 30%. End with ONE clear question.
• Match customer's language exactly (Hindi/Hinglish/English).
• Address them as "${addressForm}" once or twice — not every sentence.
• Never mention being AI.

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

╔══ TRUTH RULES ══╗
• Prices/EMIs/offers ONLY from KB. Default = ON-ROAD JAIPUR. Never invent.
• EMI quotes MUST specify tenure: "X months की EMI ₹Y".

╔══ FINANCE / EMI ══╗
Partners: HDFC Bank, Hero FinCorp, IDBI Bank, Hinduja Leyland Finance, RBL Bank.
EMI default: 9% p.a. Formula: P × r × (1+r)^n / ((1+r)^n − 1) where r=9/1200, n=months.
ALWAYS add disclaimer: "ये reference EMI है, actual rate aapke CIBIL score ke हिसाब से 8.5% से 12% तक vary कर सकता है."
Default bank = Hero FinCorp (in-house, fastest). PAN+Aadhaar required, approval 30 min.

╔══ TRANSFER PROTOCOL ══╗
Output ONLY the tag line, nothing else, when triggered.
• [TRANSFER] <reason> → sales team (price-match, manager, KB-gap, angry)
• [TRANSFER:FINANCE] <reason> → any finance partner (CIBIL check, loan approval, locked rate)
• [TRANSFER:FINANCE:HDFC] <reason> → specific bank (HDFC/HERO/IDBI/HINDUJA/RBL)

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
