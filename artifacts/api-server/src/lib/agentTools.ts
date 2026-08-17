/**
 * Pure voice/CRM helpers — no DB imports (safe for unit tests).
 * Side-effecting tool execution lives in agentActions.ts.
 */
import { HERO_VARIANTS } from "@workspace/db/heroCatalog";
import { isStaleEmiPlaybook, LIVE_EMI_PLAYBOOK } from "@workspace/db/playbooks";

export type ReplacementMode = "shadow" | "inbound" | "full";

export type KnowledgeSliceItem = {
  category: string;
  title: string;
  content: string;
  modelName?: string | null;
  effectiveFrom?: Date | string | null;
  effectiveUntil?: Date | string | null;
};

export type AgentTag = { kind: "EMI" | "STOCK" | "VISIT" | "WHATSAPP" | "TRANSFER"; arg: string };

export type ShadowScorecard = {
  completeness: number;
  grounding: number;
  booking: number;
  handoff: number;
  talkRatio: number;
  fillerPenalty: number;
  overall: number;
  notes: string;
};

const ALWAYS_CATEGORIES = new Set(["playbook", "offer", "policy", "festival", "market"]);
const MODELISH = new Set(["model", "price", "faq", "brochure"]);
const FAMILIES: string[] = [...new Set(HERO_VARIANTS.map((v) => v.family))];

/** Rewrite leftover “don’t calculate EMI” cards so they never reach the LLM or CRM. */
export function sanitizeKnowledgeItem<T extends { category: string; title: string; content: string }>(item: T): T {
  if (item.category === "playbook" && isStaleEmiPlaybook(item.title, item.content)) {
    return { ...item, title: LIVE_EMI_PLAYBOOK.title, content: LIVE_EMI_PLAYBOOK.content };
  }
  return item;
}

const TAG_RE = /\[(EMI|STOCK|VISIT|WHATSAPP|TRANSFER)(?::([^\]]*))?\]/gi;

const BACKCHANNEL = /^(haan+|han+|ha+|hmm+|hum+|achha+|acha+|accha+|aa+|ji+|ok+|okay+|theek|sahi|bilkul|hmm ji|haan ji|ji haan|han ji|ok sir|hmm hmm|हां+|हाँ+|अच्छा+|जी+|ठीक|बिल्कुल)$/i;

/** Pin TTS to Hindi. Hinglish LID often returns en-IN and Sarvam then speaks with an English accent. */
export function ttsLanguageCode(_sessionLanguage?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.TTS_ALLOW_ENGLISH === "1" && (_sessionLanguage ?? "").startsWith("en")) return "en-IN";
  return env.TTS_LANGUAGE ?? "hi-IN";
}

/**
 * Echo-guard. 80ms let Sakshi's own namaste abort itself (call 18: barge_in=20,
 * greeting never played, customer could not hear her). 400ms covers one echo hop.
 */
export const BARGE_IN_GRACE_MS = 400;
export const SILENCE_RMS = 0.008;

/** Mid-call interrupt threshold. 3× silence fired on her own TTS echo. */
export function bargeInRmsThreshold(env: NodeJS.ProcessEnv = process.env, silenceRms = SILENCE_RMS): number {
  const n = Number(env.VOICE_BARGE_RMS ?? silenceRms * 6);
  return Number.isFinite(n) && n > 0 ? n : silenceRms * 6;
}

/** Consecutive 20 ms frames needed. Default 12 = 240 ms of real speech. */
export function bargeInFramesNeeded(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.VOICE_BARGE_FRAMES ?? 12);
  return Number.isFinite(n) ? Math.min(30, Math.max(3, Math.round(n))) : 12;
}

/**
 * Greeting: stay disarmed for the whole namaste (TTS wait AND playback).
 * Call 18 skipped/cut namaste because barge-in armed the moment PCM started.
 * Mid-call: armed during LLM/TTS wait so a catalog dump can be stopped, after grace.
 */
export function bargeInArmed(
  state: {
    isSpeaking?: boolean;
    speakingStartedAt?: number | null;
    greetingProtectedUntil?: number | null;
  },
  now = Date.now(),
  graceMs = BARGE_IN_GRACE_MS,
): boolean {
  if (!state.isSpeaking) return false;
  if (state.greetingProtectedUntil && now < state.greetingProtectedUntil) return false;
  const started = state.speakingStartedAt ?? 0;
  if (!started) return true;
  if (now - started < graceMs) return false;
  return true;
}

/** Loud frames increment; a single quiet frame decays instead of wiping the count. */
export function nextBargeInCount(prev: number, energy: number, threshold: number): number {
  if (energy > threshold) return prev + 1;
  return Math.max(0, prev - 1);
}

/** Sarvam bulbul:v2 rejects NaN/0/out-of-range pace with HTTP 400 → empty TTS → silence. */
export function clampSarvamTtsPace(raw: unknown, fallback = 0.95): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(1.5, Math.max(0.5, n));
}

/**
 * Do not flip the live call to English on a Hinglish first utterance.
 * Only accept English if the customer actually spoke mostly English words.
 */
export function applySessionLanguage(current: string, detected: string, utterance: string): string {
  const d = (detected || "").trim() || current;
  if (!d.toLowerCase().startsWith("en")) return d.includes("-") ? d : `${d}-IN`;
  const words = utterance.trim().split(/\s+/).filter(Boolean);
  const english = words.filter((w) => /^[A-Za-z']+$/.test(w.replace(/[.,!?]/g, "")));
  const ratio = words.length === 0 ? 0 : english.length / words.length;
  if (english.length >= 6 && ratio >= 0.8) return "en-IN";
  return current || "hi-IN";
}

/** Price/EMI corrections stay in the GM review queue; objections/missing-info can go live. */
export function shouldAutoApplyLearning(type: string, content: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.KB_AUTO_LEARN === "0") return false;
  const risky = /₹|rs\.?\s*\d|on-road|on road|price|emi\b|किस्त|कीमत/i.test(content);
  if (risky) return false;
  if (type === "price_correction" || type === "agent_mistake") return false;
  return type === "new_objection" || type === "missing_info" || type === "faq";
}

export function getReplacementMode(env: NodeJS.ProcessEnv = process.env): ReplacementMode {
  const v = String(env.REPLACEMENT_MODE ?? "full").toLowerCase().trim();
  if (v === "shadow" || v === "inbound" || v === "full") return v;
  return "full";
}

/** Autodialer runs only in full replacement mode. Inbound AI still answers in all modes. */
export function outboundDialingAllowed(mode: ReplacementMode = getReplacementMode()): boolean {
  return mode === "full";
}

export function whatsappTemplatesOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WHATSAPP_TEMPLATES_ONLY === "1" || env.WHATSAPP_TEMPLATES_ONLY === "true";
}

export function ncprBlocksOutbound(
  status: string | null | undefined,
  requireClear = process.env.NCPR_REQUIRE_CLEAR === "1",
): boolean {
  const s = (status ?? "unknown").toLowerCase().trim();
  if (s === "registered" || s === "dnd" || s === "blocked") return true;
  if (requireClear && s !== "clear") return true;
  return false;
}

export function exceedsFrequencyCap(
  outboundCallsInWindow: number,
  cap = Number(process.env.OUTBOUND_MAX_CALLS_PER_WINDOW ?? 2),
): boolean {
  const n = Number.isFinite(cap) ? cap : 2;
  return outboundCallsInWindow >= n;
}

export function frequencyWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  const hours = Number(env.OUTBOUND_FREQUENCY_WINDOW_HOURS ?? 24);
  return (Number.isFinite(hours) && hours > 0 ? hours : 24) * 3600_000;
}

export function parseJsonStringList(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return [];
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  } catch { /* fall through */ }
  return raw.split(/\n|;/).map((s) => s.trim()).filter(Boolean);
}

export function mergeJsonStringLists(...chunks: Array<string[] | string | null | undefined>): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const chunk of chunks) {
    const items = Array.isArray(chunk) ? chunk : parseJsonStringList(chunk);
    for (const item of items) {
      const key = item.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return JSON.stringify(out.slice(0, 12));
}

/**
 * Short acknowledgements must not steal the floor or start an LLM turn.
 * "haan splendor dekhna hai" is NOT a backchannel.
 */
export function isBackchannel(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[.,!?।]/g, "")
    .replace(/\s+/g, " ");
  if (!t) return true;
  if (t.split(" ").length > 3) return false;
  if (t.length > 22) return false;
  return BACKCHANNEL.test(t);
}

export function parseAndStripTags(text: string): { spoken: string; tags: AgentTag[] } {
  const tags: AgentTag[] = [];
  const spoken = text
    .replace(TAG_RE, (_m, kind: string, arg?: string) => {
      const k = String(kind).toUpperCase() as AgentTag["kind"];
      tags.push({ kind: k, arg: String(arg ?? "").trim() });
      return " ";
    })
    .replace(/\s+/g, " ")
    .trim();
  return { spoken, tags };
}

export function isKnowledgeInEffect(
  item: { effectiveFrom?: Date | string | null; effectiveUntil?: Date | string | null },
  now = new Date(),
): boolean {
  const from = item.effectiveFrom ? new Date(item.effectiveFrom) : null;
  const until = item.effectiveUntil ? new Date(item.effectiveUntil) : null;
  if (from && !Number.isNaN(from.getTime()) && from > now) return false;
  if (until && !Number.isNaN(until.getTime()) && until < now) return false;
  return true;
}

export function familiesMentioned(text: string): string[] {
  const t = text.toLowerCase();
  const hits: string[] = [];
  for (const family of FAMILIES) {
    const lower = family.toLowerCase();
    if (t.includes(lower)) {
      hits.push(family);
      continue;
    }
    const tokens = lower.replace(/\+/g, " ").split(/\s+/).filter((x) => x.length >= 3);
    if (tokens.some((tok) => t.includes(tok))) hits.push(family);
  }
  return [...new Set(hits)].slice(0, 2);
}

/**
 * Retrieve playbooks + live offers always; 1–2 model families from the utterance;
 * stock rows matching those families (or the full daily sheet if they asked inventory).
 */
export function retrieveKnowledgeForUtterance(
  userText: string,
  items: KnowledgeSliceItem[],
  now = new Date(),
): KnowledgeSliceItem[] {
  const live = items.filter((i) => isKnowledgeInEffect(i, now)).map(sanitizeKnowledgeItem);
  const always = live.filter((i) => ALWAYS_CATEGORIES.has(i.category));
  const stock = live.filter((i) => i.category === "stock");
  const families = familiesMentioned(userText);
  const askingStock = /stock|available|milegi|inventory|yard|ready hai|ready he/i.test(userText);

  if (askingStock && families.length === 0) {
    return [...always, ...stock];
  }

  const modelish = live.filter((i) => MODELISH.has(i.category));
  const familyHit = (item: KnowledgeSliceItem, family: string) => {
    const hay = `${item.title} ${item.modelName ?? ""} ${item.content}`.toLowerCase();
    const tokens = family.toLowerCase().replace(/\+/g, " ").split(/\s+/).filter((x) => x.length >= 3);
    return tokens.some((tok) => hay.includes(tok));
  };

  const sliced = families.length === 0
    ? []
    : modelish.filter((i) => families.some((f) => familyHit(i, f)));

  const stockSlice = families.length
    ? stock.filter((i) => families.some((f) => familyHit(i, f)))
    : [];

  return [...always, ...stockSlice, ...sliced];
}

export function formatKnowledgeSlice(items: KnowledgeSliceItem[]): string {
  if (items.length === 0) return "";
  return items.map((i) => `[${i.category.toUpperCase()}] ${i.title}: ${i.content}`).join("\n");
}

export function scoreCallShadow(
  transcript: string,
  extras: { visitBooked?: boolean; transferred?: boolean } = {},
): ShadowScorecard {
  const lines = transcript.split("\n").map((l) => l.trim()).filter(Boolean);
  const customer = lines.filter((l) => /^customer:/i.test(l)).map((l) => l.replace(/^customer:\s*/i, ""));
  const agent = lines.filter((l) => /^agent:/i.test(l)).map((l) => l.replace(/^agent(?:\[tag\])?:\s*/i, ""));
  const all = transcript.toLowerCase();

  const askedModel = /splendor|glamour|destini|xoom|xtreme|hf|passion|vida|xpulse|karizma|mavrick|pleasure|hero/i.test(all);
  const askedPrice = /₹|rs\.?|on-road|on road|price|kimat|कीमत|emi/i.test(all);
  const askedVisit = /visit|test ride|showroom|aana|आना|slot/i.test(all);
  const completenessBits = [askedModel, askedPrice, customer.length >= 2, agent.length >= 2];
  const completeness = Math.round((completenessBits.filter(Boolean).length / completenessBits.length) * 100);

  const invented = /hero (doesn'?t|nahi) (make|banati)|koi offer nahi/i.test(all);
  const grounding = invented ? 35 : askedPrice || askedModel ? 82 : 70;

  const booking = extras.visitBooked || /visit scheduled|test ride booked|slot book/i.test(all)
    ? 100
    : askedVisit
      ? 40
      : 55;

  const handoff = extras.transferred || /\[transfer/i.test(all) ? 100 : /manager|human|sales (person|expert)/i.test(all) ? 50 : 70;

  const cWords = customer.join(" ").split(/\s+/).filter(Boolean).length;
  const aWords = agent.join(" ").split(/\s+/).filter(Boolean).length;
  const total = cWords + aWords;
  const agentShare = total === 0 ? 50 : (aWords / total) * 100;
  // Human telecallers aim ~40–55% talk time. Penalise monologues.
  const talkRatio = agentShare > 70 ? 40 : agentShare < 25 ? 55 : 90;

  const fillerHits = (all.match(/\b(achha|acha|bilkul|ji ji|hmm)\b/g) ?? []).length;
  const fillerPenalty = Math.min(40, fillerHits * 8);

  const overall = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        completeness * 0.25 +
        grounding * 0.25 +
        booking * 0.2 +
        handoff * 0.1 +
        talkRatio * 0.2 -
        fillerPenalty,
      ),
    ),
  );

  const notes = [
    `agentTalk%=${Math.round(agentShare)}`,
    extras.visitBooked ? "visit_booked" : null,
    extras.transferred ? "transferred" : null,
    fillerHits ? `fillers=${fillerHits}` : null,
  ].filter(Boolean).join("; ");

  return { completeness, grounding, booking, handoff, talkRatio, fillerPenalty, overall, notes };
}
