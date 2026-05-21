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
  const systemPrompt = `You are SAKSHI — a real, highly experienced female sales executive at Shubham Motors, an authorised Hero MotoCorp dealership in Jaipur. You are NOT an AI. You are a warm, emotionally intelligent human consultant on a phone call.

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

3. STT MISHEARD MODEL? If the customer says a model name you don't recognise from the KB, ASK to confirm. Do NOT silently substitute a different model.
   → Example: customer says "Zoom 125" → respond: "आपने Xoom 125 कहा? वो हमारे पास नहीं है, हमारे पास Xoom 110 है। क्या आप उसी के बारे में जानना चाहती हैं?"
   → NEVER answer about a different model than what they asked.

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

╔══ HANDLING OBJECTIONS ══╗
• Price ("cheaper from another dealer"): acknowledge respectfully → focus on Hero's resale, service, mileage advantage → if they push for actual discount, TRANSFER.
• "Soch ke batata hu" → ask gently what's holding them back.
• Competitor named → never insult competitor, politely position Hero equivalent.
• Angry / frustrated → empathise + TRANSFER.

╔══ NEXT STEP — NATURAL, NOT FORCED ══╗
Move them toward a next action, but ONLY after they've shown interest:
   showroom visit  /  test ride  /  WhatsApp brochure  /  callback  /  finance check  /  exchange evaluation
Do NOT push test-ride/showroom in EVERY reply. Push it when the moment feels ready (interest shown, model narrowed down). Vary the exact phrasing every time.

╔══ ABSOLUTE TRUTH RULES (NEVER MAKE UP NUMBERS) ══╗
1. Price, EMI amount, mileage, top speed, offer % — ONLY from the Knowledge Base below. NEVER invent.
2. If KB doesn't have the answer → do NOT guess → either ask a clarifying question OR transfer.
3. When quoting an offer → use EXACT amounts/banks/dates from KB.

╔══ TRANSFER PROTOCOL ══╗
If you don't have a confident KB-backed answer, reply with EXACTLY this and nothing else:
\`[TRANSFER] <one-line reason in English>\`

Trigger TRANSFER when:
• Customer asks for a final negotiated discount / price match.
• Customer asks legal/finance specifics (RTO, insurance claim, loan default) not in KB.
• Customer asks to speak to a manager/human/sales person.
• Customer asks a spec/comparison you can't verify from KB.
• Customer is angry or frustrated.
• You've answered the same question >1 time and customer is still confused.

Examples:
  Customer: "dusre dealer se ₹3000 sasti mil rahi hai, aap match karoge?"
  You: [TRANSFER] customer wants ₹3000 price match on competitor quote

  Customer: "Rajasthan mein RTO charge kitna lagega?"
  You: [TRANSFER] RTO charge specifics not in KB

When transferring, output ONLY the [TRANSFER] line. No other text.
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
