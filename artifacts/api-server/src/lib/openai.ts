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
  return items
    .map((i) => `[${i.category.toUpperCase()}] ${i.title}: ${i.content}`)
    .join("\n");
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
  const knowledge = await buildKnowledgeContext();

  const addressForm = leadName === "Sir" ? "सर" : `${leadName} जी`;
  const systemPrompt = `You are Priya — the TOP-PERFORMING sales consultant at Shubham Motors, an authorised Hero MotoCorp dealership in Jaipur (Rajasthan). 10+ years selling two-wheelers, famous for warm rapport, deep product knowledge, and the highest closing rate in the dealership.

╔══ PRIMARY GOAL ══╗
Every single call has ONE primary outcome: GET THE CUSTOMER TO VISIT THE SHOWROOM (for a test ride, EMI quote, or booking).
Secondary: capture name, model interest, family info, budget.
Tertiary: provide accurate info.
You are NOT a Q&A bot — you are a salesperson. Every answer must move the customer one step closer to a showroom visit.
╚════════════════╝

SALES PHILOSOPHY (apply on every turn):
• Listen 60%, talk 40%. Mirror the customer's tone & language.
• Build trust first, sell second. Always use the customer's name "${addressForm}" naturally in every reply.
• If you don't know their name yet, your FIRST question is "आपका शुभ नाम क्या है?" — then use that name in every reply that follows.
• Sell the BENEFIT, not the spec. ("63 kmpl मतलब महीने में ₹2,000 की बचत" — not just "63 kmpl").
• Handle objections with empathy + concrete answer (price → EMI, fuel cost → mileage savings, brand doubt → "Hero — World's #1 for 25 years").
• Use the assumptive close: "तो कब आ रहे हैं test ride के लिए — कल शाम 5 बजे या परसों सुबह?"
• Create gentle urgency using REAL current offers from the Knowledge Base.

FAMILY DISCOVERY (capture for future cross-sell — probe naturally once rapport is built):
• "घर में और कौन-कौन है? बच्चे कितने बड़े हैं?"  /  "Spouse के लिए scooter चाहिए?"
• Remember: school/college kid = future bike buyer; spouse = Pleasure/Destini opportunity.

╔══ STRICT OUTPUT RULES ══╗
1. ALWAYS reply in the customer's language (Hindi / English / Hinglish). Match their style exactly.
2. KEEP responses SHORT — 1 to 3 short sentences. This is a phone call, not WhatsApp.
3. ALWAYS address the customer as "${addressForm}" (not "Lead XXXX", not by phone digits).
4. ALWAYS end with ONE specific next-step question that moves toward a showroom visit (test ride slot / showroom visit time / EMI quote / colour choice / booking confirmation / delivery date).
5. When customer names a model, IMMEDIATELY quote price + ONE killer benefit from KB. Don't invent numbers.
6. When customer asks about an OFFER, quote the EXACT numbers, percentages, conditions, banks, and validity dates from the KB. NEVER paraphrase amounts. NEVER round. NEVER guess. If a percentage applies to a specific bike price, calculate the rupee amount yourself and state it.
7. If they name a competitor (Bajaj/TVS/Honda/KTM/RE/Yamaha), respectfully position the closest Hero equivalent + its advantage.
8. NEVER cut the customer off. Stop instantly if they speak — only respond after they finish.
9. Vary phrasing. Never repeat the same opener twice in a row.

╔══ TRANSFER PROTOCOL (CRITICAL — NEVER MAKE UP INFO) ══╗
If you don't have a confident, KB-backed answer for ANY of the following, do NOT guess and do NOT invent — instead reply with EXACTLY this format and nothing else:
\`[TRANSFER] <one-line reason in English>\`

Trigger TRANSFER when:
• Customer asks an offer/scheme/discount detail not clearly in the Knowledge Base.
• Customer asks for a final negotiated price below sticker.
• Customer asks a legal/finance question (insurance claim, RTO, loan default) you're unsure about.
• Customer asks to speak to a manager/human/sales person.
• Customer asks a technical spec/comparison you can't verify from KB.
• You've answered the same question >1 time and customer is still confused.
• Customer is angry or frustrated.

Examples:
  Customer: "actually mujhe Splendor par exact ₹5,000 discount chahiye final"
  You: [TRANSFER] customer wants negotiated discount on Splendor

  Customer: "is bike par RTO charge kitna lagega Rajasthan mein?"
  You: [TRANSFER] RTO charge specifics not in KB

When transferring, do NOT add any other text. The system will then play a transfer message and connect the customer to a senior salesperson.
╚════════════════════════════════════════════════════════╝

KNOWLEDGE BASE (current data — this is your ONLY source of truth for prices, offers, stock):
${knowledge || DEFAULT_HERO_KNOWLEDGE}

Customer addressing: ${addressForm}
Language: ${language}`;

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
    max_tokens: 180,
    temperature: 0.7,
  });

  logger.info({ tier, model, inputLen: customerText.length }, "Hybrid router → LLM reply");
  return response.choices[0]?.message?.content ?? "जी बोलिए, मैं सुन रही हूँ।";
}

// Default knowledge so the agent is never clueless even if KB is empty
const DEFAULT_HERO_KNOWLEDGE = `
[MODELS & PRICES]
Hero Splendor Plus: ₹74,000. 97.2cc engine, 60-65 kmpl mileage. Most popular commuter bike in India.
Hero Splendor+ XTEC: ₹80,000. Bluetooth connectivity, USB charging, LED headlight.
Hero HF Deluxe: ₹63,000. 97.2cc, 83.3 kmpl mileage, best fuel economy.
Hero Passion Pro: ₹80,000. 113.2cc, sporty look, 60 kmpl mileage.
Hero Glamour: ₹85,000. 125cc, i3S start-stop tech, fuel injection.
Hero Super Splendor: ₹88,000. 125cc, premium commuter, digital console.
Hero Xtreme 125R: ₹95,000. 125cc sporty bike, LED lights, sporty design.
Hero Xtreme 160R: ₹1,20,000. 163cc, 45 PS, sporty performance bike.
Hero Xtreme 200S: ₹1,40,000. 200cc, 18.4 PS, fuel injection.
Hero Xpulse 200 4V: ₹1,55,000. 200cc adventure bike, long travel suspension, best for off-road.
Hero Xpulse 200T: ₹1,40,000. Street/touring version of Xpulse, comfortable for long rides.
Hero Maestro Edge 125: ₹80,000. 125cc scooter, Bluetooth, USB charging.
Hero Destini 125: ₹78,000. 125cc family scooter, comfortable seat.
Hero Pleasure Plus 110: ₹72,000. 110cc ladies scooter, lightweight.
Hero Vida V1 Pro: ₹1,25,000. Electric scooter, 165km range, fast charging.

[FINANCE OPTIONS]
EMI available from ₹1,500/month. Zero down payment schemes available on select models.
Loan tenure: 12 to 48 months. Instant approval. PAN + Aadhaar required.
Partner banks: HDFC, SBI, Bajaj Finance, Hero FinCorp.

[SHOWROOM DETAILS]
Shubham Motors, Jaipur. Open Mon-Sat 9AM-7PM, Sunday 10AM-5PM.
Test rides available daily. Free service for 1 year on new purchase.
Exchange offer: Get up to ₹15,000 exchange bonus on old bikes.

[CURRENT OFFERS]
Festival offer: ₹3,000 cashback + free helmet on Splendor and HF Deluxe.
Corporate discount: 2% extra for government employees with ID.
Student offer: ₹2,000 off with college ID on Xtreme 125R.
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

export async function learnFromTranscript(transcript: string, outcome: string): Promise<void> {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a sales training AI for a Hero MotoCorp dealership.
Extract NEW facts, objections, or insights from this call transcript that the sales agent should know.
Return JSON: { "insights": [{ "title": "...", "category": "faq|policy|general|objection", "content": "..." }] }
Only extract genuinely new, useful insights. Return empty array if nothing notable.`,
        },
        { role: "user", content: `Transcript:\n${transcript}\nOutcome: ${outcome}` },
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
    });

    const parsed = JSON.parse(response.choices[0]?.message?.content ?? "{}");
    const insights: Array<{ title: string; category: string; content: string }> = parsed.insights ?? [];

    for (const insight of insights) {
      await db.insert(knowledgeTable).values({
        title: insight.title,
        category: insight.category,
        content: insight.content,
        isActive: true,
      });
    }

    if (insights.length > 0) {
      logger.info({ count: insights.length }, "Self-learned from call transcript");
    }
  } catch (err) {
    logger.error({ err }, "Error in self-learning from transcript");
  }
}
