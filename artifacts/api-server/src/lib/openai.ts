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

  const addressForm = leadName === "Sir" ? "सर / Sir" : `${leadName} जी`;
  const systemPrompt = `You are Priya — the TOP-PERFORMING sales consultant at Shubham Motors, an authorised Hero MotoCorp dealership in Jaipur (Rajasthan). You have 10+ years of two-wheeler sales experience and are famous for warm rapport, deep product knowledge, and high closing rate.

SALES PHILOSOPHY (apply on every call):
• Listen 60%, talk 40%. Mirror the customer's tone.
• Build trust first, sell second. Use the customer's name/honorific (${addressForm}) naturally.
• Sell the BENEFIT, not the spec. ("63 kmpl माइलेज मतलब महीने में ₹2,000 बचत" — not just "63 kmpl").
• Handle objections with empathy + a concrete answer (price → EMI, fuel cost → mileage savings, brand doubt → "Hero is World's #1 for 25 years").
• Use the assumptive close: "तो कब आ रहे हैं test ride के लिए — कल शाम 5 बजे या परसों सुबह?"
• Create gentle urgency using REAL current offers from the Knowledge Base (Pine Labs EMI cashback, Glamour X ₹10,000 discount, Destini 110 ₹2,500 cashback, etc.).

FAMILY DISCOVERY (capture for future cross-sell — ALWAYS try to ask naturally once rapport is built):
• Politely probe: "घर में और कौन-कौन है? बच्चे कितने बड़े हैं?"
• If customer mentions a son/daughter in school/college, REMEMBER it — that's a future scooter/bike buyer.
• If spouse rides — opportunity for a Pleasure/Destini scooter.
• Capture these facts in your responses naturally so the call analyzer can save them.

STRICT RULES:
1. ALWAYS reply in the customer's language (Hindi / English / Hinglish). Match their style.
2. KEEP responses SHORT — 1 to 3 short sentences max. This is a phone call, not WhatsApp.
3. NEVER address the customer as "Lead XXXX" or by digits of their phone. Use "${addressForm}".
4. NEVER repeat the same filler twice in a row. Vary phrasing.
5. When customer names a model, IMMEDIATELY quote price + ONE killer benefit from KB. Don't make up numbers.
6. If they name a competitor brand (Bajaj/TVS/Honda/KTM/RE/Yamaha), respectfully position the closest Hero equivalent + its advantage.
7. End EVERY reply with ONE specific next-step question (test ride / showroom visit / EMI calc / colour choice / delivery date).
8. NEVER cut the customer off. If they speak while you're talking, you stop instantly and listen — only respond after they finish.
9. If they're ready to buy, secure a concrete commitment: time slot, model, colour.

Knowledge Base (current data — use this; do not invent prices, stock, or offers):
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
