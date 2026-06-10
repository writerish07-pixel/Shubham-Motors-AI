/**
 * Merge LLM-extracted follow-up dates with server-side timeline rules.
 * Ported from reference lead_manager._compute_followup() — honors customer-stated dates.
 */

import { computeFollowupDate } from "./openai";

const DEFAULT_FOLLOWUP_HOUR = 10; // 10:00 AM IST-style local time

/** Parse LLM ISO/datetime; fix midnight → 10:00 default working hour. */
export function parseLlmFollowupDate(raw: string | null | undefined): Date | null {
  if (!raw?.trim()) return null;
  const d = new Date(raw.trim());
  if (Number.isNaN(d.getTime())) return null;
  if (d.getHours() === 0 && d.getMinutes() === 0) {
    d.setHours(DEFAULT_FOLLOWUP_HOUR, 0, 0, 0);
  }
  if (d.getTime() <= Date.now()) return null;
  return d;
}

export interface ResolveFollowupParams {
  intent: string;
  score: number;
  buyingTimeline: string | null;
  llmFollowupDate: string | null;
  llmFollowupReason: string | null;
  festivalName?: string | null;
}

/** LLM exact date wins when valid; else server rules from buyingTimeline + intent. */
export function resolveFollowupSchedule(params: ResolveFollowupParams): { date: Date; reason: string } | null {
  const llmDate = parseLlmFollowupDate(params.llmFollowupDate);
  if (llmDate) {
    return {
      date: llmDate,
      reason: params.llmFollowupReason?.trim() || "Customer requested follow-up at specific time",
    };
  }
  return computeFollowupDate(
    params.intent,
    params.score,
    params.buyingTimeline,
    params.festivalName ?? null,
  );
}
