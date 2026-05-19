import OpenAI from "openai";
import { db } from "@workspace/db";
import { knowledgeTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

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

  const systemPrompt = `You are Priya, a warm and expert sales agent at Shubham Motors — an authorized Hero MotoCorp dealership in Jaipur (India).

Your goal: understand the customer, match them to the right Hero bike, and drive a showroom visit or booking.

STRICT RULES:
1. ALWAYS reply in the SAME language as the customer (Hindi/English/Mix as they speak). If they speak Hindi, reply in Hindi.
2. KEEP responses SHORT — max 2-3 sentences. This is a phone call.
3. NEVER repeat "क्या आप थोड़ा और डिटेल दे सकते हैं" twice in a row. Each response must be different.
4. If customer names a specific bike (Splendor, Passion, Xpulse, etc.), IMMEDIATELY give its price/feature from knowledge base.
5. If customer mentions a non-Hero brand (Bajaj, TVS, KTM, Royal Enfield, Zero), clarify you are Hero MotoCorp dealer and offer the closest Hero alternative.
6. After answering a question, always end with ONE specific follow-up question or offer (test ride, visit, EMI calculation).
7. If customer seems ready to buy, push for appointment: "आज शाम को showroom आ सकते हैं?"

Knowledge Base (use this — do not make up prices or specs):
${knowledge || DEFAULT_HERO_KNOWLEDGE}

Customer name: ${leadName}
Language: ${language}`;

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...conversationHistory.map((t) => ({ role: t.role, content: t.content })),
    { role: "user", content: customerText },
  ];

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    max_tokens: 150,
    temperature: 0.6,
  });

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
