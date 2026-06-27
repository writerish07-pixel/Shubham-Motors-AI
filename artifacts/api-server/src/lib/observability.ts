/**
 * Observability primitives (Production Hardening Phase 3 / 4).
 *
 * Lightweight, dependency-free correlation IDs + per-stage latency timing for
 * the voice pipeline. Designed to be wired into callStream.ts incrementally
 * without touching its control flow: create one `StageTimer` per call, `mark()`
 * around each stage (STT / routing / LLM / TTS / audio), then `report()` once at
 * the end to emit a single structured timing log + a machine-readable summary
 * that can be persisted as the per-call quality report (Phase 4).
 */

import { randomUUID } from "node:crypto";
import { logger } from "./logger";

/** Short, log-friendly correlation id. */
export function newTraceId(): string {
  return randomUUID();
}

export type PipelineStage =
  | "stt"
  | "language_detection"
  | "routing"
  | "knowledge"
  | "llm"
  | "response_generation"
  | "tts"
  | "audio_processing"
  | "xml_generation"
  | "other";

export interface StageTiming {
  stage: PipelineStage;
  ms: number;
  /** Optional: which provider/path served this stage, e.g. "sarvam" / "whisper". */
  via?: string;
  ok: boolean;
}

export interface ConversationTimingReport {
  traceId: string;
  conversationId?: string;
  customerId?: string | number;
  turn: number;
  totalMs: number;
  stages: StageTiming[];
  /** Per-stage totals keyed by stage name, for easy dashboards. */
  byStage: Partial<Record<PipelineStage, number>>;
}

/**
 * Accumulates per-stage timings for a single conversation turn. Not thread-safe
 * by design — one instance per call/turn. Clock is injectable for tests.
 */
export class StageTimer {
  private readonly stages: StageTiming[] = [];
  private readonly startedAt: number;

  constructor(
    public readonly traceId: string = newTraceId(),
    public readonly turn: number = 0,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.startedAt = now();
  }

  /** Time an async stage; records duration + ok/fail and re-throws on error. */
  async time<T>(stage: PipelineStage, fn: () => Promise<T>, via?: string): Promise<T> {
    const t0 = this.now();
    try {
      const out = await fn();
      this.record(stage, this.now() - t0, true, via);
      return out;
    } catch (err) {
      this.record(stage, this.now() - t0, false, via);
      throw err;
    }
  }

  /** Record a pre-measured duration (when you can't wrap the call). */
  record(stage: PipelineStage, ms: number, ok = true, via?: string): void {
    this.stages.push({ stage, ms: Math.round(ms), ok, via });
  }

  build(meta?: { conversationId?: string; customerId?: string | number }): ConversationTimingReport {
    const byStage: Partial<Record<PipelineStage, number>> = {};
    for (const s of this.stages) {
      byStage[s.stage] = (byStage[s.stage] ?? 0) + s.ms;
    }
    return {
      traceId: this.traceId,
      conversationId: meta?.conversationId,
      customerId: meta?.customerId,
      turn: this.turn,
      totalMs: Math.round(this.now() - this.startedAt),
      stages: this.stages,
      byStage,
    };
  }

  /** Emit a single structured timing log and return the report. */
  report(meta?: { conversationId?: string; customerId?: string | number }): ConversationTimingReport {
    const r = this.build(meta);
    logger.info({ timing: r }, "Conversation turn timing");
    return r;
  }
}
