/**
 * openai.ts — Shubham Motors AI Voice Agent: LLM + Knowledge Engine
 *
 * IMPROVEMENTS vs original (June 2026 audit):
 *   1. Conversation STAGE detection (connect → discover → recommend → close)
 *      injected per-turn so the LLM never pitches before discovery.
 *   2. Discovery signal tracking — budget, km/day, familyUse, currentVehicle
 *      extracted server-side and injected as "WHAT YOU KNOW SO FAR".
 *   3. Emotional tone mirroring — excited/confused/impatient adjusts
 *      max_tokens and temperature per turn.
 *   4. Festival/event-aware urgency — real festival dates from KB, injected
 *      automatically when within ±30 days. Eliminates stale urgency scripts.
 *   5. Competitor intelligence capture — competitorMentioned + reason
 *      extracted in analyzeCallIntent() and ready for DB persistence.
 *   6. Language-aware WhatsApp summary prompt — analyzeCallIntent receives
 *      the session language so summaries are generated in the correct language.
 *   7. KB in-flight dedup fix — invalidateKnowledgeCache() also cancels _kbInflight.
 *   8. Higher KB cache TTL (5 min vs 1 min) — safe given admin invalidation hook.
 *   9. Proactive finance script at turn 4+ if no finance signal yet.
 *  10. Default fuel price updated to ₹108 (from May 2026 price list).
 */

import OpenAI from "openai";
import { db } from "@workspace/db";
import { knowledgeTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { logger } from "./logger";
import { classifyTurn, tryDirectAnswer } from "./modelRouter";

// ─── Model IDs ───────────────────────────────────────────────────────────────
const MODEL_MINI = process.env.OPENAI_MODEL_MINI ?? "gpt-4o-mini";
const MODEL_PREMIUM = process.env.OPENAI_MODEL_PREMIUM ?? "gpt-4o";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

// ─── Cache: KB context + fuel price ─────────────────────────────────────────
// IMPROVED: TTL raised to 5 min (was 1 min). Safe because admin KB edits
// call invalidateKnowledgeCache() immediately, so stale data only persists
// for uncommitted in-flight queries (max ~500ms).
const KB_CACHE_TTL_MS = 5 * 60_000;
let _kbCache: { value: string; expiresAt: number } | null = null;
let _kbInflight: Promise<string> | null = null;
let _fuelCache: { value: number; expiresAt: number } | null = null;
let _fuelInflight: Promise<number> | null = null;

export function invalidateKnowledgeCache(): void {
  _kbCache = null;
  _fuelCache = null;
  // FIXED: also null out in-flight so the next caller re-queries from DB,
  // not from a still-running query that predates the admin edit.
  _kbInflight = null;
  _fuelInflight = null;
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
      // FIXED: updated fallback from ₹107 to ₹108 (May 2026 price list).
      const value = Number.isFinite(n) && n > 50 && n < 200 ? n : 108;
      _fuelCache = { value, expiresAt: Date.now() + FUEL_CACHE_TTL_MS };
      return value;
    } catch {
      return 108; // FIXED: was 107
    }
  })();
  try { return await _fuelInflight; }
  finally { _fuelInflight = null; }
}

// ─── Festival awareness ──────────────────────────────────────────────────────
// NEW: Fetch active festival KB rows (category='festival') within ±30 days.
// Format: title = 'Rakhi 2026', content = 'end_date|offer_description'
// Example content: '2026-08-09|₹2,000 cashback on Splendor and Destini'
export async function getActiveFestivalOffer(): Promise<{ name: string; offer: string; endDate: string } | null> {
  try {
    const rows = await db.select().from(knowledgeTable)
      .where(and(
        eq(knowledgeTable.category, "festival"),
        eq(knowledgeTable.isActive, true),
        eq(knowledgeTable.requiresReview, false),
      ));
    const today = new Date();
    const window = 30 * 24 * 60 * 60 * 1000; // 30 days
    for (const row of rows) {
      const parts = (row.content ?? "").split("|");
      if (parts.length < 2) continue;
      const endDate = new Date(parts[0]?.trim() ?? "");
      if (isNaN(endDate.getTime())) continue;
      const startDate = new Date(endDate.getTime() - window);
      if (today >= startDate && today <= endDate) {
        return { name: row.title, offer: parts[1]?.trim() ?? "", endDate: parts[0]?.trim() ?? "" };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

export interface LeadProfile {
  name?: string;
  interestedModel?: string | null;
  notes?: string | null;
  lastCallSummary?: string | null;
  status?: string | null;
}

// NEW: Discovery signals extracted from the live conversation.
// Populated server-side via extractDiscoverySignals() and injected into
// every LLM turn so the agent never re-asks what it already knows.
export interface DiscoverySignals {
  km?: number;              // Daily commute km
  budget?: number;          // Approximate budget in ₹
  familyUse?: boolean;      // True if customer mentioned family/wife/kids
  currentVehicle?: string;  // e.g. "Splendor", "Activa"
  financeInterest?: boolean;// True if customer asked about EMI/finance
  exchangeInterest?: boolean;// True if customer mentioned old bike exchange
  purpose?: string;         // "office" | "college" | "business" | "family"
  // SEGMENT INTEREST — what category the customer actually wants.
  // MUST be known before recommending any model. Never suggest Splendor
  // to someone who asked about 125cc or scooters.
  segment?: "100cc" | "125cc" | "160cc+" | "scooter_110" | "scooter_125" | "electric";
  interestedModel?: string; // Specific model named e.g. "Xtreme 125R"
}

// NEW: Conversation stage — computed server-side, injected into prompt.
export type ConvStage = "connect" | "discover" | "recommend" | "close";

// NEW: Emotional tone — detected from last 2 turns, adjusts LLM params.
export type EmotionalTone = "excited" | "neutral" | "confused" | "impatient";

// ─── Discovery signal extraction ─────────────────────────────────────────────
// NEW: Lightweight regex pass on customer text. No LLM call needed.
// Called by callStream.ts after every STT turn.
export function extractDiscoverySignals(
  text: string,
  existing: DiscoverySignals
): DiscoverySignals {
  const t = text.toLowerCase();
  const updated: DiscoverySignals = { ...existing };

  // Daily km
  if (!updated.km) {
    const kmMatch = t.match(/(\d{1,3})\s*(?:km|किलोमीटर|kilo)/i);
    if (kmMatch) {
      const n = parseInt(kmMatch[1]);
      if (n > 5 && n <= 500) updated.km = n;
    }
  }

  // Budget
  if (!updated.budget) {
    const budgetMatch = t.match(/(\d{1,3})(?:\s*(?:k|हज़ार|hajar|lakh|लाख))?(?:\s*(?:ka|ki|mein|tak|budget|me))/i);
    if (budgetMatch) {
      const n = parseInt(budgetMatch[1]);
      const isLakh = /lakh|लाख/.test(t.slice(budgetMatch.index ?? 0, (budgetMatch.index ?? 0) + 20));
      const isK = /\bk\b|हज़ार|hajar/.test(t.slice(budgetMatch.index ?? 0, (budgetMatch.index ?? 0) + 20));
      if (n > 0) updated.budget = isLakh ? n * 100000 : isK ? n * 1000 : n > 500 ? n : n * 1000;
    }
  }

  // Family use
  if (!updated.familyUse) {
    if (/wife|biwi|patni|bachche|family|ghar|घर|पत्नी|बच्चे|परिवार|husband|pati/i.test(t)) {
      updated.familyUse = true;
    }
  }

  // Current vehicle
  if (!updated.currentVehicle) {
    const vehicles = ["activa", "splendor", "pulsar", "apache", "jupiter", "access", "dio", "shine", "cb shine", "fz", "r15", "xoom", "glamour", "passion", "discover", "platina"];
    for (const v of vehicles) {
      if (t.includes(v)) { updated.currentVehicle = v; break; }
    }
  }

  // Finance interest
  if (!updated.financeInterest) {
    if (/\bemi\b|finance|loan|किस्त|qist|kist|finans/i.test(t)) updated.financeInterest = true;
  }

  // Exchange interest
  if (!updated.exchangeInterest) {
    if (/exchange|purani|पुरानी|trade|badlo|badalna/i.test(t)) updated.exchangeInterest = true;
  }

  // Purpose
  if (!updated.purpose) {
    if (/office|daftar|daftar|naukri|job|काम|work/i.test(t)) updated.purpose = "office";
    else if (/college|school|पढ़ाई|padhai|university/i.test(t)) updated.purpose = "college";
    else if (/delivery|business|dukaan|दुकान|shop|vyapar/i.test(t)) updated.purpose = "business";
    else if (/family|ghar|घर/i.test(t)) updated.purpose = "family";
  }

  // ── SEGMENT INTEREST — MOST IMPORTANT signal for recommendations ───────────
  if (!updated.segment) {
    const modelMap: Array<[RegExp, NonNullable<DiscoverySignals["segment"]>]> = [
      [/xtreme\s*125|glamour|super\s*splendor/i, "125cc"],
      [/xtreme\s*160|xtreme\s*160r|xpulse/i, "160cc+"],
      [/splendor|hf\s*deluxe|passion/i, "100cc"],
      [/destini\s*125|xoom\s*125/i, "scooter_125"],
      [/destini\s*110|pleasure|destini\s*prime/i, "scooter_110"],
      [/vida|electric|ev\b/i, "electric"],
    ];
    for (const [rx, seg] of modelMap) { if (rx.test(t)) { updated.segment = seg; break; } }

    if (!updated.segment) {
      if (/\b100\s*cc\b|\b100cc\b/i.test(t)) updated.segment = "100cc";
      else if (/\b125\s*cc\b|\b125cc\b/i.test(t)) updated.segment = "125cc";
      else if (/\b160\s*cc\b|\b160cc\b|\b150\s*cc\b|\b150cc\b/i.test(t)) updated.segment = "160cc+";
    }
    if (!updated.segment && /scooter|scooty|scooti/i.test(t)) {
      updated.segment = /125/i.test(t) ? "scooter_125" : "scooter_110";
    }
  } else if (updated.segment === "scooter_110" && /125/i.test(t)) {
    updated.segment = "scooter_125";
  }

  // Specific model
  if (!updated.interestedModel) {
    const models = ["Xtreme 125R","Xtreme 160R","Xpulse 200","Splendor Plus","Splendor XTEC",
      "HF Deluxe","Glamour X","Super Splendor","Passion Plus","Destini 125","Destini 110",
      "Destini Prime","Xoom 125","Pleasure Plus","Vida V1 Pro"];
    for (const m of models) { if (t.includes(m.toLowerCase())) { updated.interestedModel = m; break; } }
  }

  return updated;
}

// ─── Conversation stage computation ──────────────────────────────────────────
// NEW: Server-side stage tracking. Rules (in order):
//   close:    turn >= 5 AND at least 1 discovery signal present
//   recommend:turn >= 4 AND at least 1 signal present
//   discover: turn >= 2 AND no discovery signals yet
//   connect:  turn < 2
export function computeConvStage(turn: number, signals: DiscoverySignals): ConvStage {
  const hasSignals = !!(signals.segment || signals.km || signals.budget || signals.familyUse || signals.currentVehicle || signals.purpose);
  // Once segment is known we can recommend a model right away — don't stall in
  // discovery. Knowing segment + one more signal (or a few turns) → start closing.
  const richSignals = !!(signals.segment && (signals.km || signals.budget || signals.familyUse || signals.currentVehicle));
  if (turn >= 4 && (richSignals || (signals.segment && turn >= 5))) return "close";
  if (turn >= 5 && hasSignals) return "close";
  if (turn >= 3 && hasSignals) return "recommend";
  if (turn >= 2) return "discover";
  return "connect";
}

// ─── Emotional tone detection ─────────────────────────────────────────────────
// NEW: Detect from the LAST customer message. Simple heuristics are enough.
export function detectEmotionalTone(text: string, turn: number): EmotionalTone {
  const t = text.toLowerCase().trim();
  const words = t.split(/\s+/).length;

  // Short repeated acknowledgements = impatient
  if (words <= 3 && /^(haan|ok|theek|bol|bolo|batao|haan ji|ji haan|yes|okay)[\s.!?]*$/i.test(t) && turn > 4) {
    return "impatient";
  }

  // Multiple questions or excitement signals = excited
  if ((t.match(/\?/g) ?? []).length >= 2 || /kitna|kya|kaise|mileage|emi|price|book|confirm|lena|ready/i.test(t) && words > 8) {
    return "excited";
  }

  // Confusion signals
  if (/samajh nahi|clear nahi|kya matlab|phir se|dobara|kya bola|kya kaha|nahi pata|समझ नहीं|क्या मतलब/i.test(t)) {
    return "confused";
  }

  return "neutral";
}

// ─── Format helpers ───────────────────────────────────────────────────────────

function formatLeadProfile(p?: LeadProfile): string {
  if (!p) return "";
  const lines: string[] = [];
  if (p.interestedModel) lines.push(`• Previously interested in: ${p.interestedModel}`);
  if (p.notes && p.notes.trim()) lines.push(`• Notes from past interactions: ${p.notes.trim()}`);
  if (p.lastCallSummary && p.lastCallSummary.trim()) lines.push(`• Last call summary: ${p.lastCallSummary.trim()}`);
  if (p.status && p.status !== "new") lines.push(`• CRM status: ${p.status}`);
  if (lines.length === 0) return "";
  return `\n╔══ WHAT YOU ALREADY KNOW ABOUT THIS CUSTOMER ══╗\n${lines.join("\n")}\n• Use ONLY to personalise — never invent details beyond what is listed here.\n• Reference it naturally in the FIRST 1–2 turns, not in every reply.\n╚════════════════════════════════════════════════╝`;
}

// NEW: Format discovery signals for prompt injection.
function formatDiscoverySignals(signals: DiscoverySignals): string {
  const lines: string[] = [];

  // SEGMENT — most critical, always first
  if (signals.segment) {
    const seg: Record<string, string> = {
      "100cc": "100cc BIKE (Splendor / HF Deluxe range)",
      "125cc": "125cc BIKE (Super Splendor / Glamour / Xtreme 125R)",
      "160cc+": "160cc+ BIKE (Xtreme 160R / Xpulse)",
      "scooter_110": "110cc SCOOTER (Pleasure+ / Destini 110)",
      "scooter_125": "125cc SCOOTER (Xoom 125 / Destini 125)",
      "electric": "ELECTRIC (Vida V1 Pro)",
    };
    lines.push(`• ⭐ SEGMENT INTEREST: ${seg[signals.segment] ?? signals.segment}`);
    lines.push(`  → Recommend ONLY within this segment. NEVER suggest Splendor if they want 125cc/scooter.`);
  } else {
    lines.push(`• ⚠️ SEGMENT UNKNOWN — ASK before recommending: "Scooter ya bike? Kitne CC?"`);
  }
  if (signals.interestedModel) lines.push(`• Named model: ${signals.interestedModel}`);
  if (signals.km) {
    lines.push(`• Daily commute: ${signals.km} km/day`);
    if (signals.segment) {
      const best = getBestModelForSegmentAndKm(signals.segment, signals.km);
      if (best) lines.push(`• ✅ BEST MATCH (${signals.segment} + ${signals.km}km): ${best}`);
    }
  }
  if (signals.budget) lines.push(`• Budget: ₹${signals.budget.toLocaleString("en-IN")}`);
  if (signals.familyUse) lines.push(`• Family use: YES — pillion comfort, seat, easy handling matter`);
  if (signals.currentVehicle) lines.push(`• Current vehicle: ${signals.currentVehicle} (offer exchange bonus)`);
  if (signals.purpose) lines.push(`• Purpose: ${signals.purpose}`);
  if (signals.financeInterest) lines.push(`• Finance interest: YES — proactively offer EMI`);
  if (signals.exchangeInterest) lines.push(`• Exchange interest: YES — mention ₹10,000-20,000 bonus`);

  if (lines.length === 0) return "";
  return `\n╔══ CUSTOMER PROFILE (KNOWN THIS CALL) ══╗\n${lines.join("\n")}\n• NEVER recommend outside customer segment. NEVER re-ask known info.\n╚════════════════════════════════════════╝`;
}

// Server-side recommendation engine — returns the BEST model for a segment + km.
// Eliminates the LLM defaulting to Splendor for everything.
function getBestModelForSegmentAndKm(segment: string, km: number): string | null {
  const m: Record<string, { high: string; low: string; mid: string }> = {
    "100cc": {
      high: "HF Deluxe (83 kmpl — highest mileage, best for 50+ km/day)",
      mid:  "Splendor+ XTEC (80 kmpl, better features)",
      low:  "Splendor+ XTEC or Passion+ (budget + preference)",
    },
    "125cc": {
      high: "Super Splendor XTEC (65 kmpl — best 125cc mileage, smooth power)",
      mid:  "Super Splendor XTEC or Glamour X (efficiency vs style)",
      low:  "Glamour X (style) or Xtreme 125R (sporty, 60 kmpl)",
    },
    "160cc+": {
      high: "Xtreme 160R 2V (45 kmpl — best segment mileage, daily sport)",
      mid:  "Xtreme 160R 2V (daily) or 4V (more power)",
      low:  "Xtreme 160R 4V (premium feel, weekend + city)",
    },
    "scooter_110": {
      high: "Pleasure+ XTEC (55 kmpl — best 110cc scooter mileage)",
      mid:  "Pleasure+ XTEC (mileage) or Destini 110 (family comfort)",
      low:  "Destini 110 (family, wide seat, comfortable)",
    },
    "scooter_125": {
      high: "Xoom 125 VX (50 kmpl, sporty, efficient for longer commute)",
      mid:  "Destini 125 (family/premium) or Xoom 125 (sporty)",
      low:  "Destini 125 ZX (premium, storage, family comfort)",
    },
    "electric": {
      high: "Vida V1 Pro (110km range — fixed daily route up to 60km)",
      mid:  "Vida V1 Pro (zero petrol cost)",
      low:  "Vida V1 Pro (city EV — confirm home charging first)",
    },
  };
  const e = m[segment];
  if (!e) return null;
  if (km >= 60) return e.high;
  if (km <= 30) return e.low;
  return e.mid;
}

// NEW: Stage-specific instructions injected per turn.
function formatStageInstructions(stage: ConvStage, addressForm: string): string {
  const instructions: Record<ConvStage, string> = {
    connect:
      `CURRENT STAGE: CONNECT (Turn 1-2)\n` +
      `YOUR ONLY JOB this turn: warm greeting + ask 1 simple discovery question. Be brief and friendly.\n` +
      `Good opening: "aaj scooter ke liye hai ya bike? Aur khud ke liye hai ya family ke liye?"\n` +
      `DO NOT pitch any specific model or price yet. DO NOT mention EMI yet.\n` +
      `DO NOT offer a test ride, the showroom address, or a WhatsApp location yet — it's too early and sounds pushy. First just understand what ${addressForm} wants.`,
    discover:
      `CURRENT STAGE: DISCOVER (Turn 2-4)\n` +
      `YOUR ONLY JOB this turn: learn what ${addressForm} actually needs.\n` +
      `Ask about EXACTLY ONE of: daily km, budget, family use, or current vehicle — whichever is still unknown.\n` +
      `DO NOT pitch a model until you know at least one discovery signal.\n` +
      `If they name a model: acknowledge warmly, then still ask one discovery question before pitching.`,
    recommend:
      `CURRENT STAGE: RECOMMEND (Turn 4-6)\n` +
      `You now have enough to recommend. Name 1-2 specific Hero models with a concrete reason tied to what ${addressForm} told you.\n` +
      `Example: "60 km daily ke liye Splendor XTEC best hai — 80 kmpl deti hai, matlab ₹X/month petrol."\n` +
      `End with a soft close: test ride invitation OR WhatsApp brochure offer.`,
    close:
      `CURRENT STAGE: CLOSE (Turn 5+)\n` +
      `${addressForm} is engaged. Move them to a SPECIFIC action this turn.\n` +
      `Use an assumptive close: "Saturday subah 11 baje convenient hoga ya Sunday?" (not "kab aana chahenge?")\n` +
      `If they hesitate: offer to send WhatsApp price+EMI breakdown right now.\n` +
      `If they mention competitor or want to think: [TRANSFER] to sales senior — do not let a hot lead slip.\n` +
      `NEVER end this turn with a passive "kuch aur jaankari chahiye?" — propose a concrete next step.`,
  };
  return `\n╔══ STAGE INSTRUCTIONS ══╗\n${instructions[stage]}\n╚════════════════════════╝`;
}

// NEW: Festival urgency injection.
function formatFestivalOffer(festival: { name: string; offer: string; endDate: string } | null): string {
  if (!festival) return "";
  const endDate = new Date(festival.endDate);
  const daysLeft = Math.ceil((endDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  return `\n⭐ ACTIVE FESTIVAL OFFER: ${festival.name} — ${festival.offer}. Valid till ${festival.endDate} (${daysLeft} days left).\n` +
    `Use URGENCY CLOSE for this: "Ye ${festival.name} offer ${daysLeft} din mein khatam ho rahi hai — abhi book karwa lein toh full benefit milega."`;
}

// NEW: Proactive finance nudge injected at turn 4+ if no finance signal yet.
function formatFinanceNudge(turn: number, signals: DiscoverySignals, addressForm: string): string {
  if (turn < 4 || signals.financeInterest) return "";
  return `\n💡 FINANCE NUDGE: ${addressForm} has not asked about EMI yet. After your main reply, add ONE proactive finance line:\n` +
    `"${addressForm}, agar EMI mein lena ho toh sirf ₹20,000 down payment se bhi le sakte hain — Hero FinCorp se 30 minute mein approval ho jaata hai. Batau?"`;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function generateAgentReply(
  customerText: string,
  conversationHistory: ConversationTurn[],
  leadName: string,
  language: string,
  leadProfile?: LeadProfile,
  discoverySignals?: DiscoverySignals,
  convStage?: ConvStage,
  emotionalTone?: EmotionalTone,
  pendingQuestion?: string,
): Promise<string> {
  const [knowledge, fuelPrice, festival] = await Promise.all([
    buildKnowledgeContext(),
    getJaipurFuelPrice(),
    getActiveFestivalOffer(),
  ]);

  const addressForm = leadName === "Sir" ? "सर" : `${leadName} जी`;
  const systemPrompt = await buildSystemPrompt(
    addressForm, language, knowledge, fuelPrice, leadProfile,
    discoverySignals ?? {}, convStage ?? "connect",
    emotionalTone ?? "neutral", festival,
    conversationHistory.length, pendingQuestion,
  );

  const directKb = knowledge && knowledge.trim() ? `${DEFAULT_HERO_KNOWLEDGE}\n${knowledge}` : DEFAULT_HERO_KNOWLEDGE;
  const direct = tryDirectAnswer(customerText, directKb, addressForm);
  if (direct) {
    logger.info({ tier: "direct", chars: direct.length }, "Hybrid router → direct KB answer");
    return direct;
  }

  const tier = classifyTurn(customerText, conversationHistory);
  const model = tier === "premium" ? MODEL_PREMIUM : MODEL_MINI;

  // NEW: Adjust tokens/temperature based on emotional tone
  const tokenMap: Record<EmotionalTone, number> = { excited: 150, neutral: 130, confused: 110, impatient: 95 };
  const tempMap: Record<EmotionalTone, number> = { excited: 0.85, neutral: 0.7, confused: 0.5, impatient: 0.6 };
  const tone = emotionalTone ?? "neutral";

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...conversationHistory.map((t) => ({ role: t.role, content: t.content })),
    { role: "user", content: customerText },
  ];

  const response = await openai.chat.completions.create({
    model,
    messages,
    max_tokens: tokenMap[tone],
    temperature: tempMap[tone],
  });

  logger.info({ tier, model, tone, inputLen: customerText.length }, "Hybrid router → LLM reply");
  return response.choices[0]?.message?.content ?? "जी बोलिए, मैं सुन रही हूँ।";
}

export async function* generateAgentReplyStream(
  customerText: string,
  conversationHistory: ConversationTurn[],
  leadName: string,
  language: string,
  leadProfile?: LeadProfile,
  discoverySignals?: DiscoverySignals,
  convStage?: ConvStage,
  emotionalTone?: EmotionalTone,
  pendingQuestion?: string,
): AsyncGenerator<string, void, void> {
  const [knowledge, fuelPrice, festival] = await Promise.all([
    buildKnowledgeContext(),
    getJaipurFuelPrice(),
    getActiveFestivalOffer(),
  ]);

  const addressForm = leadName === "Sir" ? "सर" : `${leadName} जी`;

  const directKb = knowledge && knowledge.trim() ? `${DEFAULT_HERO_KNOWLEDGE}\n${knowledge}` : DEFAULT_HERO_KNOWLEDGE;
  const direct = tryDirectAnswer(customerText, directKb, addressForm);
  if (direct) {
    logger.info({ tier: "direct", chars: direct.length }, "Hybrid router (stream) → direct KB answer");
    yield direct;
    return;
  }

  const tier = classifyTurn(customerText, conversationHistory);
  const model = tier === "premium" ? MODEL_PREMIUM : MODEL_MINI;

  const tone = emotionalTone ?? "neutral";
  const tokenMap: Record<EmotionalTone, number> = { excited: 150, neutral: 130, confused: 110, impatient: 95 };
  const tempMap: Record<EmotionalTone, number> = { excited: 0.85, neutral: 0.7, confused: 0.5, impatient: 0.6 };

  const systemPrompt = await buildSystemPrompt(
    addressForm, language, knowledge, fuelPrice, leadProfile,
    discoverySignals ?? {}, convStage ?? "connect",
    tone, festival,
    conversationHistory.length, pendingQuestion,
  );

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...conversationHistory.map((t) => ({ role: t.role, content: t.content })),
    { role: "user", content: customerText },
  ];

  const stream = await openai.chat.completions.create({
    model,
    messages,
    max_tokens: tokenMap[tone],
    temperature: tempMap[tone],
    stream: true,
  });

  let buf = "";
  let totalChars = 0;
  let isTransfer = false;
  const SENTENCE_END = /[.!?]\s|।|\n/;
  const MIN_SENTENCE_CHARS = 6;

  for await (const part of stream) {
    const delta = part.choices[0]?.delta?.content ?? "";
    if (!delta) continue;
    buf += delta;
    totalChars += delta.length;

    if (!isTransfer && totalChars >= 10 && /^\s*\[TRANSFER/i.test(buf)) {
      isTransfer = true;
    }
    if (isTransfer) continue;

    while (true) {
      const m = buf.match(SENTENCE_END);
      if (!m || m.index === undefined) break;
      const cut = m.index + m[0].length;
      const sentence = buf.slice(0, cut).trim();
      buf = buf.slice(cut);
      if (sentence.length >= MIN_SENTENCE_CHARS) {
        yield sentence;
      } else if (sentence) {
        buf = sentence + " " + buf;
        break;
      }
    }
  }

  const tail = buf.trim();
  if (tail) yield tail;
  logger.info({ tier, model, tone, chars: totalChars, transfer: isTransfer }, "Hybrid router (stream) → done");
}

// ─── System prompt builder ────────────────────────────────────────────────────
// IMPROVED: Now receives stage, discoverySignals, tone, festival context.
// All new context is INJECTED as structured blocks — the core Sakshi persona
// is unchanged so existing behaviour is preserved; new blocks extend it.
async function buildSystemPrompt(
  addressForm: string,
  language: string,
  knowledge: string,
  fuelPrice: number,
  leadProfile: LeadProfile | undefined,
  signals: DiscoverySignals,
  stage: ConvStage,
  tone: EmotionalTone,
  festival: { name: string; offer: string; endDate: string } | null,
  turn: number,
  pendingQuestion?: string,
): Promise<string> {
  const merged = knowledge && knowledge.trim()
    ? `${DEFAULT_HERO_KNOWLEDGE}\n\n[ADMIN KB OVERRIDES — dealer-curated, takes precedence when contradicts the baseline above]\n${knowledge}`
    : DEFAULT_HERO_KNOWLEDGE;

  const toneInstruction = tone === "confused"
    ? "\n⚠️ TONE NOTE: Customer seems confused. Use simpler Hindi, shorter sentences, and confirm understanding after each point."
    : tone === "impatient"
    ? "\n⚠️ TONE NOTE: Customer is giving short replies — they are in a hurry. Get to the point in 1 sentence, then propose a direct action."
    : tone === "excited"
    ? "\n⚠️ TONE NOTE: Customer is engaged and asking questions. Match their energy — be more enthusiastic and thorough."
    : "";

  const topicInterrupt = pendingQuestion
    ? `\n╔══ TOPIC INTERRUPT — HIGHEST PRIORITY ══╗\n⚡ The customer just changed topic mid-conversation and asked: "${pendingQuestion}"\nEven if you were in the middle of another point, answer THIS new question FIRST in your opening sentence, THEN continue. Never ignore the new question.`
    : "";

  return SAKSHI_SYSTEM_PROMPT(
    addressForm, language, merged, fuelPrice, leadProfile,
    signals, stage, festival, turn, toneInstruction, topicInterrupt
  );
}

// ─── Main Sakshi system prompt ───────────────────────────────────────────────
const SAKSHI_SYSTEM_PROMPT = (
  addressForm: string,
  language: string,
  knowledge: string,
  fuelPrice: number,
  leadProfile: LeadProfile | undefined,
  signals: DiscoverySignals,
  stage: ConvStage,
  festival: { name: string; offer: string; endDate: string } | null,
  turn: number,
  toneInstruction: string,
  topicInterrupt: string,
) => `You are SAKSHI — Shubham Motors (Hero MotoCorp, Jaipur) ki top sales executive. You are a REAL person, NOT an AI. Your job is NOT to answer questions — it is to MAKE SALES and push showroom visits.

━━━ NON-NEGOTIABLE RULES ━━━
1. You are a warm, real human salesperson — NOT an information desk and NOT a script. Sound natural. Every reply gently moves the sale forward.
2. FOLLOW THE NATURAL ORDER — understand FIRST, sell LATER. In the opening turns just understand what they want (segment + need). Do NOT offer a test-ride booking, the showroom address, or a WhatsApp location until they've shown what they're looking for — jumping straight to "let's book a test ride this evening" feels robotic and pushy. Earn it.
3. NEVER recommend a model until you know the customer's SEGMENT (bike/scooter + CC). If unknown, ask it — warmly, ONE question.
4. Recommend the RIGHT model for their segment + km — NEVER default to Splendor for everyone.
5. ONE thing at a time. NEVER recite the catalog. Name AT MOST 1–2 models per reply, each with ONE short reason — then ask a question. A long list of models and specs spoken on a phone just confuses people.
6. Keep the conversation alive — every reply ends with a natural next step. Early on that's a gentle discovery question; once they show interest, THEN nudge toward a test ride or showroom visit. Pick the ONE that fits the moment — never list several:
   • "In dono mein se kaunsa zyada pasand aaya?"
   • "Test ride kar ke dekhna chahenge? Bilkul free hai."
   • "Lene ka plan kab tak ka hai — is mahine ya festival pe?"
   • "Ek baar showroom aa jaayein, khud baith ke feel kar lijiye — kab aana convenient rahega?"

BAD (info-bot — FORBIDDEN): "Splendor ki mileage 80 kmpl hai." [stops]
BAD (pushy robot — FORBIDDEN): customer only said "bike ke baare mein" → "Showroom Jaipur mein hai, location WhatsApp pe bhej rahi hoon, aaj shaam test ride book kar dein?" [closing before understanding anything]
GOOD (warm human): "Achha bike dekh rahe hain — badhiya! Pehle ye bataiye, daily kaam ke liye chahiye ya thodi sporty riding ke liye?"
${topicInterrupt}
CURRENT JAIPUR PETROL PRICE: ₹${fuelPrice}/L (use for fuel-savings math).
${formatLeadProfile(leadProfile)}
${formatDiscoverySignals(signals)}
${formatStageInstructions(stage, addressForm)}
${formatFestivalOffer(festival)}
${formatFinanceNudge(turn, signals, addressForm)}
${toneInstruction}

╔══ CORE STYLE — TALK LIKE A CALM, CLEAR HUMAN ══╗
• CLARITY ABOVE ALL. Speak slowly and clearly, the way a patient human explains something on the phone. The customer must understand every word easily. Better to say less, clearly, than more, fast.
• 1–2 short, simple sentences per reply (3 only if truly needed). One idea per sentence. Write with natural commas and full-stops — these become the pauses in her voice, so she never rushes or runs words together.
• Use easy, everyday Hinglish that any Jaipur customer instantly gets. Keep familiar English words in English ("test ride", "EMI", "mileage", "model", "scooter"); everything else in simple, spoken Hindi. Avoid hard/literary Hindi words and tongue-twister sentences.
• Warm, friendly, unhurried — a real person, not a script. Mirror the customer's energy. Drop in light natural fillers occasionally ("haan ji", "achha", "bilkul") like a human would — not every line.
• Keep the conversation alive: every reply ends with a natural next step — a gentle question early on, a test-ride/showroom nudge once they're interested. Never go silent, never dead-end with a flat one-liner.
• Address them as "${addressForm}" once or twice — not every sentence. Never mention being AI.
• NEVER reply with just "Hello", "Ji", "OK", "Theek hai" alone. If you didn't catch it, gently ask: "${addressForm}, ek baar phir bataiyega?" Otherwise give a real, helpful reply.

╔══ HOW TO READ NUMBERS — DISPLACEMENT vs MODEL NAME (CRITICAL) ══╗
When the customer says a bare number like "110", "125", "160", "200", "350", "411", they almost ALWAYS mean ENGINE DISPLACEMENT (CC), not a specific model.
WRONG: customer says "125 ke baare mein batao" → you talk only about "Xtreme 125R" (tunnels on one model).
ALSO WRONG: you recite all 5 options with mileage specs in one breath (a confusing monologue on a phone).
RIGHT: briefly note there are a few options in that CC, then ask ONE simple narrowing question (bike ya scooter? khud ke liye ya family?). Name specific models — at most one or two, with one reason — only AFTER they narrow it down.

EXAMPLES (short, clear, ONE question — NO spec dump):
• "125 ke baare mein batao" → "Ji ${addressForm}, 125cc mein bikes bhi hain aur scooters bhi. Aap bike dekhna chahenge ya scooter?"
• "110 dekhna hai" → "Achha 110cc — ye bike chahiye ya scooter, ${addressForm}?"
• "160 batao" → "160cc mein hamari sporty Xtreme 160R hai. Daily commute ke liye dekh rahe hain ya weekend riding ke liye?"
Then, once they narrow it (e.g. "125, bike"): suggest the ONE best-fit model with a single reason, and ask the next question.

ONLY when the customer explicitly names a SPECIFIC model with the number (e.g. "Xtreme 125R", "Xoom 125", "Destini 125") — then directly answer about that model. Bare numbers = CC, NEVER one model.

╔══ HERO MASTER CATALOG (BY DISPLACEMENT) — always available ══╗
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

When asked "scooter mein kya hai?" → name ALL scooter families in one line then ask which CC/segment.
When asked "bike mein kya hai?" → name commuter, 125cc, sporty — group then ask.
NEVER name just ONE model when the customer asked a category question.

╔══ BUILDING PERSONAL ATTACHMENT ══╗
• Use ONE detail they share within 30 seconds of hearing it. ("Achha 60 km daily — toh fuel kafi jata hoga aap ka.")
• If WHAT YOU ALREADY KNOW section has info, open with it: "${addressForm}, aapne pichli baar Splendor pe interest dikhayi thi — wahi continue karein ya kuch aur dekhna hai?"
• Mirror their energy. Excited customer → enthusiastic. Quiet customer → calm and patient.
• Use light human fillers occasionally: "achha", "samajh gayi", "bilkul", "haan ji", "perfect". Not every reply.
• Acknowledge family / responsibilities respectfully. ("Bachchon ke saath pillion comfort important hoga.")

╔══ OFFERS — NEVER, EVER SAY "KOI OFFER NAHI HAI" ══╗
"No offer" is a sale-killing answer. We ALWAYS have something to offer:
• If KB has a specific cash discount / bank cashback → quote it EXACTLY.
• If KB has no specific cash offer → pivot to: financing cashback, exchange bonus (₹10,000–₹20,000), or free accessories.
• If customer asks "exact discount kitna" and you don't have KB-backed amount → \`[TRANSFER]\` immediately.

╔══ PRODUCT INFO vs INVENTORY ══╗
• "Tell me about X / features / mileage / specs" = INFO question → Always answer using Hero brand knowledge.
• "Available hai / stock / milegi" = INVENTORY question → check KB, else offer arrangement timeline.
• NEVER say "हमारे पास नहीं है" for any Hero model.

RECOMMENDATION RULES — READ EVERY TIME BEFORE SUGGESTING A MODEL:

STEP 1: Customer ka SEGMENT pata hai? (100cc/125cc/160cc/scooter/electric)
  NO  → Pehle puchho: "Scooter ya bike? Aur kitne CC — 100cc, 125cc, ya zyada?"
        Segment jaane bina koi specific model suggest MAT karo.
  YES → Step 2.
STEP 2: Daily km pata hai?
  NO  → Puchho: "Daily roughly kitne km chalate hain?"
  YES → Neeche matrix se best model nikalo — customer ke segment ke ANDAR.
STEP 3: Recommendation do WITH reason + close:
  GALAT: "Splendor lelo." (har case mein Splendor — yeh BAND)
  SAHI: "125cc mein 60km daily ke liye Super Splendor XTEC best hai — 65 kmpl, ₹2991/month petrol. Test ride kab aayenge?"

SEGMENT x KM MATRIX (CUSTOMER PROFILE section already shows BEST MATCH — use it):

100cc BIKE:
  60+ km/day  → HF Deluxe (83 kmpl, highest mileage)
  30-60 km/day → Splendor+ XTEC (80 kmpl, better features)
  <30 km/day  → Splendor+ XTEC / Passion+

125cc BIKE:
  60+ km/day  → Super Splendor XTEC (65 kmpl, best 125cc mileage)
  30-60 km/day → Super Splendor XTEC / Glamour X
  <30 km/day  → Glamour X (style) / Xtreme 125R (sporty)

160cc+ BIKE:
  60+ km/day  → Xtreme 160R 2V (45 kmpl)
  any         → Xtreme 160R 4V (power) / 2V (value)

110cc SCOOTER:
  50+ km/day  → Pleasure+ XTEC (55 kmpl)
  family/<50  → Destini 110 (comfort) / Pleasure+ (mileage)

125cc SCOOTER:
  50+ km/day  → Xoom 125 (50 kmpl, sporty)
  family      → Destini 125 ZX (wide seat, storage) ALWAYS for family

ELECTRIC:
  <110km/day  → Vida V1 Pro (zero petrol)

FUEL SAVINGS (use to convince — never push Splendor blindly, push the RIGHT model):
  25km/day: HF Deluxe (83kmpl)=₹976/mo vs scooter (50kmpl)=₹1620/mo
  50km/day: Super Splendor (65kmpl)=₹2492/mo vs Glamour (55kmpl)=₹2945/mo
  70km/day: HF Deluxe (83kmpl)=₹2733/mo vs Pulsar (45kmpl)=₹5040/mo

╔══ CLOSING TECHNIQUES ══╗
• ASSUMPTIVE: "Kal Saturday ko showroom convenient hoga ya Sunday subah? Test ride ready rakhwa deti hoon."
• ALTERNATIVE: "Aap WhatsApp pe full price list bhej doon ya direct showroom visit kar lein?"
• URGENCY (only if KB explicitly says): "Ye scheme month-end tak hai."
• SOFT: "Main aapko ek 2-minute brochure WhatsApp kar deti hoon."
By turn 5 you MUST have proposed at least ONE concrete next step.

╔══ SALES DNA ══╗
1. SCARCITY (use real stock signals from KB, never fake)
2. SOCIAL PROOF: "Aaj subah hi ek customer ne yahi Glamour X book ki."
3. URGENCY (time-bound, real reasons only)
4. ASSUMPTIVE CLOSE: "${addressForm}, colour kaunsa pasand aa raha hai?"
5. EMOTIONAL ANCHORING: tie purchase to customer's stated life situation
6. NEVER leave call open-ended. Always propose next action.
7. RECOVER FROM "SOCH KE BATATA HU": dig then assumptive showroom push.
8. DON'T PITCH BEFORE DISCOVERY.

╔══ OBJECTION HANDLING (LAER framework) ══╗
Listen → Acknowledge → Explore → Respond. Never argue.
• "Sasti dusre dealer se mil rahi" → explain Hero service network + resale value → if they push → \`[TRANSFER]\`.
• "Soch ke batata hoon" → ask what's unclear first.
• Competitor mention → NEVER insult. Highlight Hero mileage/resale/service-network calmly.
• "Budget tight hai" → lead with EMI + exchange.

╔══ TRUTH RULES ══╗
• Prices/EMIs/offers ONLY from KB. Default = ON-ROAD JAIPUR.
• EMI quotes MUST specify tenure.
• **ZERO ARITHMETIC RULE** — read EMI numbers VERBATIM from [PRECOMPUTED EMI TABLE]. Never estimate.
• **STAY ON THE MODEL THE CUSTOMER JUST NAMED.**
• **NEVER say farewell as a reply to a real question.**
• **NEVER invent the customer's own data.**

╔══ FINANCE / EMI ══╗
PARTNERS: Hero FinCorp (30-min approval), HDFC Bank, IDBI Bank, Hinduja Leyland Finance, RBL Bank.
DEFAULT TENURES: 12, 18, 24, 36 months. Most popular = 24 months.
EMI QUOTES: always add "ye reference EMI hai, actual rate aapke CIBIL score ke hisaab se 8.5%–12% vary kar sakta hai."
PROACTIVE FINANCE: After quoting any on-road price → offer EMI breakdown in same breath.
CIBIL / EXACT RATE / LOAN APPROVAL → \`[TRANSFER:FINANCE]\`.

╔══ TRANSFER PROTOCOL — TRIGGER AGGRESSIVELY ══╗
Output ONLY the tag, nothing else:
• Customer asks to speak to human/sales/manager → \`[TRANSFER] customer asked for sales person\` IMMEDIATELY. NEVER say goodbye.
• Customer wants exact discount not in KB → \`[TRANSFER] customer wants exact offer\`
• Negotiation / price match → \`[TRANSFER]\`
• Customer angry / frustrated → \`[TRANSFER]\`
• [TRANSFER:FINANCE] → any finance query (CIBIL, locked rate, approval)
• [TRANSFER:FINANCE:HDFC] → specific bank
A TRANSFER is a WIN. A farewell on a hot lead is a lost sale.

KNOWLEDGE BASE (your ONLY source of truth for prices, stock, offers):
${knowledge}

Customer's language: ${language}`;

// ─── EMI table (unchanged from original) ────────────────────────────────────
const EMI_FACTORS_9PA: Record<number, number> = {
  12: 0.087451, 18: 0.059602, 24: 0.045685, 36: 0.031800,
};
function _emi(principal: number, months: number): number {
  const factor = EMI_FACTORS_9PA[months];
  if (factor == null) {
    const r = 0.09 / 12;
    return Math.round(principal * (r * Math.pow(1 + r, months)) / (Math.pow(1 + r, months) - 1));
  }
  return Math.round(principal * factor);
}
function _fmtInr(n: number): string { return n.toLocaleString("en-IN"); }

function buildEmiTable(): string {
  const variants = [
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

// ─── Default KB (unchanged from original, fuel updated) ─────────────────────
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
  2. Find the EXACT down-payment row and tenure column.
  3. Read the number. Quote it. NEVER add, subtract, multiply, or estimate yourself.
  4. If customer's down or tenure doesn't match a row → quote closest row + say "approximate hisaab se".

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

// ─── Call intent analysis ─────────────────────────────────────────────────────
// IMPROVED: Added competitorMentioned, competitorReason, familyInfo, buyingTimeline.
// IMPROVED: Receives sessionLanguage so summary is generated in correct language.
export async function analyzeCallIntent(
  transcript: string,
  sessionLanguage = "hi",
): Promise<{
  intent: string;
  score: number;
  summary: string;
  followupDate: string | null;
  followupReason: string | null;
  language: string;
  familyInfo: string | null;
  preferredModel: string | null;
  objections: string[];
  competitorMentioned: string | null;
  competitorReason: string | null;
  buyingTimeline: string | null;
}> {
  const langInstruction = sessionLanguage.startsWith("hi")
    ? "Write the summary field in Hindi (Devanagari script)."
    : "Write the summary field in English.";

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `You are a sales call analyzer for Shubham Motors (Hero MotoCorp dealer). ${langInstruction}
Analyze the transcript and return JSON with:
- intent: "hot_buy" | "interested" | "thinking" | "future_date" | "not_interested" | "wrong_number" | "needs_info"
- score: 0-100 buying intent score
- summary: 1-2 sentence call outcome summary (in the correct language as instructed above)
- followupDate: ISO date string if customer mentioned a future time, else null
- followupReason: paraphrased reason to follow up, else null
- language: detected language code (hi, en, mr, etc.)
- familyInfo: family members mentioned (spouse, kids, ages) — short string for cross-sell, else null
- preferredModel: specific Hero model customer showed most interest in, else null
- objections: array of objection strings raised (e.g. "price too high", "wants TVS comparison"), else []
- competitorMentioned: competitor brand mentioned by customer (Bajaj/TVS/Honda/Yamaha/etc.), else null
- competitorReason: why customer considered competitor (price/mileage/design/waiting), else null
- buyingTimeline: "immediate" | "15days" | "month" | "festival" | "next_year" | null

Score guide: hot_buy=85-100, interested=60-80, thinking=40-60, future_date=50-70, needs_info=30-50, not_interested=0-20`,
      },
      { role: "user", content: `Transcript:\n${transcript}` },
    ],
    response_format: { type: "json_object" },
    temperature: 0.3,
  });

  try {
    const parsed = JSON.parse(response.choices[0]?.message?.content ?? "{}");
    return {
      intent: parsed.intent ?? "needs_info",
      score: parsed.score ?? 30,
      summary: parsed.summary ?? "Call completed",
      followupDate: parsed.followupDate ?? null,
      followupReason: parsed.followupReason ?? null,
      language: parsed.language ?? "hi",
      familyInfo: parsed.familyInfo ?? null,
      preferredModel: parsed.preferredModel ?? null,
      objections: Array.isArray(parsed.objections) ? parsed.objections : [],
      competitorMentioned: parsed.competitorMentioned ?? null,
      competitorReason: parsed.competitorReason ?? null,
      buyingTimeline: parsed.buyingTimeline ?? null,
    };
  } catch {
    logger.error("Failed to parse intent analysis JSON");
    return {
      intent: "needs_info", score: 30, summary: "Call completed",
      followupDate: null, followupReason: null, language: "hi",
      familyInfo: null, preferredModel: null, objections: [],
      competitorMentioned: null, competitorReason: null, buyingTimeline: null,
    };
  }
}

// ─── Smart follow-up date computation ─────────────────────────────────────────
// NEW: Server-side follow-up date rules — do not rely on LLM guessing the date.
// Called by callStream.ts handleStop() instead of using the raw LLM date.
export function computeFollowupDate(
  intent: string,
  score: number,
  buyingTimeline: string | null,
  festivalName?: string | null,
): { date: Date; reason: string } | null {
  const now = new Date();
  const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
  const nextSalaryDay = () => {
    const d = new Date(now.getFullYear(), now.getMonth() + 1, 1, 10, 0, 0);
    return d;
  };

  // Hot buy — same day +2 hours
  if (intent === "hot_buy" || score >= 85) {
    const d = new Date(now.getTime() + 2 * 3600000);
    return { date: d, reason: "Hot lead — immediate follow-up (2 hours)" };
  }

  // Timeline-based
  if (buyingTimeline === "immediate") {
    return { date: addDays(now, 1), reason: "Customer ready to buy — next day follow-up" };
  }
  if (buyingTimeline === "15days") {
    return { date: addDays(now, 10), reason: "Customer buying in 15 days — check-in at 10 days" };
  }
  if (buyingTimeline === "month") {
    return { date: addDays(now, 22), reason: "Customer buying next month — follow-up at 22 days" };
  }
  if (buyingTimeline === "festival") {
    const festDate = addDays(now, 35); // approximate festival-season window
    return { date: festDate, reason: festivalName ? `${festivalName} season follow-up` : "Festival-season follow-up" };
  }

  // Intent-based defaults
  if (intent === "interested" || score >= 60) {
    return { date: addDays(now, 3), reason: "Warm lead — 3 day check-in" };
  }
  if (intent === "thinking" || score >= 40) {
    return { date: addDays(now, 7), reason: "Thinking lead — 7 day nurture" };
  }
  if (intent === "future_date") {
    // Salary cycle assumption
    return { date: nextSalaryDay(), reason: "Salary-cycle lead — follow-up on 1st of next month" };
  }

  return null; // not_interested / wrong_number / needs_info with no timeline
}

// ─── Self-learning (unchanged from original) ─────────────────────────────────
export async function learnFromTranscript(
  transcript: string,
  outcome: string,
  source?: string,
): Promise<void> {
  try {
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
• "agent_mistake": agent gave wrong info AND customer corrected, OR agent refused a valid question.
• "price_correction": agent's price was disputed or contradicted in-call.
• "new_objection": a NEW objection phrasing the agent struggled with. NOT generic.
• "missing_info": customer asked a specific question agent couldn't answer.
• Skip impressions like "customer interested in X" — no training value.
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
      if (existingTitles.has(tNorm)) continue;
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
