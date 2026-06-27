/**
 * Resilience primitives for external API calls (Production Hardening Phase 2).
 *
 * Pure, dependency-free helpers — no axios/openai coupling, so they are trivial
 * to unit-test and can wrap any async operation. Use `withRetry` for calls that
 * are NOT on the tight in-call voice latency budget (WhatsApp, outbound dial,
 * transfer). The in-call STT/TTS path intentionally does NOT retry here — it
 * relies on its own short timeouts + circuit breaker + Whisper fallback so the
 * customer never waits through a backoff mid-conversation.
 */

import { logger } from "./logger";

export interface RetryOptions {
  /** Max attempts including the first try. Default 3. */
  retries?: number;
  /** Base backoff in ms for the first retry. Default 300. */
  baseDelayMs?: number;
  /** Upper bound on any single backoff. Default 5000. */
  maxDelayMs?: number;
  /** Label for structured logs, e.g. "whatsapp.send". */
  label?: string;
  /** Correlation id threaded into retry logs (Phase 3). */
  traceId?: string;
  /** Decide whether an error is worth retrying. Default `isRetryableError`. */
  shouldRetry?: (err: unknown) => boolean;
  /** Injectable sleep — tests pass a no-op to run instantly. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Transient-failure classifier. Retries network blips, timeouts, and 5xx/429
 * responses; does NOT retry 4xx (except 429) — a 400/401/404 won't fix itself.
 */
export function isRetryableError(err: unknown): boolean {
  const e = err as {
    code?: string;
    response?: { status?: number };
    status?: number;
    message?: string;
  };

  // Network / socket level (axios + node)
  const transientCodes = new Set([
    "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ECONNABORTED",
    "EAI_AGAIN", "EPIPE", "ENOTFOUND", "ERR_CANCELED",
  ]);
  if (e.code && transientCodes.has(e.code)) return true;

  const status = e.response?.status ?? e.status;
  if (typeof status === "number") {
    if (status === 429) return true;
    if (status >= 500 && status <= 599) return true;
    return false; // other 4xx are not retryable
  }

  // axios timeout surfaces as a message when code is absent
  if (typeof e.message === "string" && /timeout/i.test(e.message)) return true;

  return false;
}

/** Full-jitter exponential backoff: random in [0, min(max, base*2^attempt)]. */
export function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.floor(Math.random() * ceiling);
}

/**
 * Run `fn`, retrying transient failures with exponential backoff + jitter.
 * Re-throws the last error once attempts are exhausted, so callers keep their
 * existing try/catch + graceful-fallback behaviour unchanged.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const {
    retries = 3,
    baseDelayMs = 300,
    maxDelayMs = 5000,
    label = "external-call",
    traceId,
    shouldRetry = isRetryableError,
    sleep = defaultSleep,
  } = opts;

  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isLast = attempt === retries - 1;
      if (isLast || !shouldRetry(err)) {
        if (attempt > 0) {
          logger.warn({ label, traceId, attempt: attempt + 1, retries }, "Retries exhausted");
        }
        throw err;
      }
      const delay = backoffDelay(attempt, baseDelayMs, maxDelayMs);
      logger.warn(
        { label, traceId, attempt: attempt + 1, retries, delayMs: delay },
        "External call failed — retrying after backoff",
      );
      await sleep(delay);
    }
  }
  // Unreachable (loop either returns or throws), but satisfies the type checker.
  throw lastErr;
}

/**
 * Race a promise against a hard timeout. Unlike axios `timeout`, this works for
 * any awaitable (DB query, SDK call) that has no native timeout option.
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  ms: number,
  label = "operation",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
