/** Prompts + fallback for post-call audit vs telecaller recording upload. */

export type LearnFromTranscriptMode = "post_call_audit" | "telecaller_recording";

export type LearnFromTranscriptOpts = {
  source?: string;
  mode?: LearnFromTranscriptMode;
  forceReview?: boolean;
};

export type LearnFromTranscriptResult = {
  extracted: number;
  inserted: number;
  queued: number;
  autoApplied: number;
  skipped: number;
};

export type ExtractedLearnItem = {
  type: string;
  category: string;
  title: string;
  content: string;
  evidence?: string;
};

export const EMPTY_LEARN_RESULT: LearnFromTranscriptResult = {
  extracted: 0,
  inserted: 0,
  queued: 0,
  autoApplied: 0,
  skipped: 0,
};

export const LEARN_VALID_CATEGORIES = new Set([
  "faq",
  "policy",
  "objection",
  "models",
  "price",
  "general",
  "playbook",
]);

export const POST_CALL_AUDIT_PROMPT = `You audit Hero MotoCorp dealership sales calls. Extract ONLY high-signal items the sales team must know — NOT vague impressions.

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
• If nothing meets the bar, return {"items": []}. Empty is GOOD — quality over quantity.`;

export const TELECALLER_RECORDING_PROMPT = `You extract reusable sales skills from a HUMAN telecaller recording at Shubham Motors (Hero MotoCorp, Jaipur). This is NOT an audit of Sakshi. Speakers are unlabeled Hindi/Hinglish.

Return JSON: { "items": [{
  "type": "telecaller_skill" | "opening" | "objection_script" | "close_script" | "new_objection",
  "category": "playbook" | "objection" | "faq" | "policy" | "models" | "price" | "general",
  "title": "<short, specific — max 80 chars>",
  "content": "<situation + the Hindi Devanagari line Sakshi should say next time>",
  "evidence": "<verbatim quote from the transcript>"
}] }

STRICT RULES:
• Extract 3–8 reusable skills whenever there is sales talk (greeting, model pitch, objection, visit close, EMI, family/budget).
• NEVER return {"items": []} if the transcript has dealership sales conversation. Empty only for silence, IVR, or unrelated chatter.
• Lines Sakshi should speak MUST be Hindi Devanagari (not English, not Roman Hindi).
• NEVER invent a cash discount, rupee match, or "hum bhi ₹X denge". If the telecaller named an exact cash figure, write: exact cash discount unknown — [TRANSFER] Priyanka 9610165555.
• Do not treat two catalog variant prices as a correction (Xtreme 125R IBS / ABS / Dual ABS are all real).
• Skip customer personal names; keep the skill generic.`;

export const TELECALLER_FALLBACK_MIN_CHARS = 80;

export function parseLearnOpts(sourceOrOpts?: string | LearnFromTranscriptOpts): LearnFromTranscriptOpts {
  if (typeof sourceOrOpts === "string" || sourceOrOpts == null) {
    return { source: sourceOrOpts, mode: "post_call_audit" };
  }
  return sourceOrOpts;
}

export function shouldInsertTelecallerFallback(extractedCount: number, transcript: string): boolean {
  return extractedCount === 0 && transcript.trim().length >= TELECALLER_FALLBACK_MIN_CHARS;
}

export function buildTelecallerFallbackItem(source: string, transcript: string): ExtractedLearnItem {
  const snippet = transcript.replace(/\s+/g, " ").trim().slice(0, 700);
  const label = source.replace(/^upload:/i, "").slice(0, 48) || "untitled";
  const day = new Date().toISOString().slice(0, 10);
  return {
    type: "telecaller_skill",
    category: "playbook",
    title: `Telecaller recording: ${label} (${day})`.slice(0, 80),
    content:
      `Review this telecaller call and keep the useful Hindi lines. Do not invent a cash discount. If they named an exact rupee off, [TRANSFER] Priyanka.\n\nTranscript:\n${snippet}`,
    evidence: snippet.slice(0, 400),
  };
}

export function formatRecordingUploadToast(j: {
  itemsInserted?: number;
  itemsQueuedForReview?: number;
  itemsSkipped?: number;
  transcriptChars?: number;
}): { kind: "success" | "warning"; message: string } {
  const inserted = j.itemsInserted ?? 0;
  const queued = j.itemsQueuedForReview ?? 0;
  const skipped = j.itemsSkipped ?? 0;
  if (inserted > 0) {
    return {
      kind: "success",
      message: `Learned ${inserted} — ${queued} in Review queue. Open the amber cards and Approve.`,
    };
  }
  if (skipped > 0) {
    return {
      kind: "warning",
      message: "Heard the call — those lines are already in Review. No duplicates added.",
    };
  }
  return {
    kind: "warning",
    message: `Heard the call (${j.transcriptChars ?? 0} chars) but extracted 0 skills. Try a clearer MP3 or M4A.`,
  };
}
