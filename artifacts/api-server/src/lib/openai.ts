import OpenAI from "openai";
import { db } from "@workspace/db";
import { knowledgeTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

  const systemPrompt = `You are Priya, an expert sales agent at Shubham Motors — an authorized Hero MotoCorp dealership. You are the best salesperson in the industry.

Your goals (in order):
1. Understand the customer's need and match them to the right Hero bike
2. Drive showroom visits and test rides
3. Close sales or collect strong commitment

Rules:
- ALWAYS reply in the SAME language as the customer: ${language}
- Be warm, confident, and professional — like a trusted advisor, not a pushy seller
- If customer interrupts or seems to want to speak, stop talking and listen
- Keep responses SHORT and conversational — this is a phone call
- Never make up prices or specs; use only the knowledge base
- If customer mentions a future date/occasion (Diwali, next week, salary, etc.), acknowledge it and note it for follow-up
- If customer is VERY interested and says they want to buy soon or are ready — that is a HOT lead, mark them as such
- Ask one question at a time; don't bombard

Knowledge base:
${knowledge || "No knowledge base items loaded yet. Use general Hero MotoCorp knowledge."}

Customer name: ${leadName}`;

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...conversationHistory.map((t) => ({ role: t.role, content: t.content })),
    { role: "user", content: customerText },
  ];

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    max_tokens: 200,
    temperature: 0.7,
  });

  return response.choices[0]?.message?.content ?? "Sorry, could you repeat that?";
}

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
- intent: one of "hot_buy" | "interested" | "thinking" | "future_date" | "not_interested" | "wrong_number" | "needs_info"
- score: lead score 0-100 based on buying intent
- summary: 1-2 sentence summary of the call outcome
- followupDate: ISO date string if customer mentioned a future time (e.g. "after Diwali", "next week") else null
- followupReason: why to follow up (customer's own words paraphrased) else null
- language: detected language code (hi, en, mr, ta, te, etc.)

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
          content: `You are a sales training AI. Extract any new facts, objections, or useful insights from this call transcript that a Hero MotoCorp sales agent should know.
Return JSON: { "insights": [{ "title": "...", "category": "faq|policy|general", "content": "..." }] }
Only return genuinely new, useful insights. Return empty array if nothing notable.`,
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
