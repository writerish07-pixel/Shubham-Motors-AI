import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isRetryableError,
  backoffDelay,
  withRetry,
  withTimeout,
} from "../src/lib/resilience";

const noSleep = async (): Promise<void> => {};

test("isRetryableError: transient network + 5xx + 429 are retryable", () => {
  assert.equal(isRetryableError({ code: "ECONNRESET" }), true);
  assert.equal(isRetryableError({ code: "ETIMEDOUT" }), true);
  assert.equal(isRetryableError({ response: { status: 503 } }), true);
  assert.equal(isRetryableError({ response: { status: 429 } }), true);
  assert.equal(isRetryableError({ message: "timeout of 5000ms exceeded" }), true);
});

test("isRetryableError: 4xx (except 429) and unknown are NOT retryable", () => {
  assert.equal(isRetryableError({ response: { status: 400 } }), false);
  assert.equal(isRetryableError({ response: { status: 401 } }), false);
  assert.equal(isRetryableError({ response: { status: 404 } }), false);
  assert.equal(isRetryableError(new Error("nope")), false);
});

test("backoffDelay: bounded by min(maxDelay, base*2^attempt)", () => {
  for (let attempt = 0; attempt < 6; attempt++) {
    const d = backoffDelay(attempt, 300, 5000);
    const ceiling = Math.min(5000, 300 * 2 ** attempt);
    assert.ok(d >= 0 && d <= ceiling, `attempt ${attempt}: ${d} > ${ceiling}`);
  }
});

test("withRetry: succeeds on first try without sleeping", async () => {
  let calls = 0;
  const out = await withRetry(async () => { calls++; return "ok"; }, { sleep: noSleep });
  assert.equal(out, "ok");
  assert.equal(calls, 1);
});

test("withRetry: retries transient failures then succeeds", async () => {
  let calls = 0;
  const out = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw { code: "ECONNRESET" };
      return "recovered";
    },
    { retries: 3, sleep: noSleep },
  );
  assert.equal(out, "recovered");
  assert.equal(calls, 3);
});

test("withRetry: does NOT retry a non-retryable error", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => { calls++; throw { response: { status: 400 } }; },
        { retries: 5, sleep: noSleep },
      ),
  );
  assert.equal(calls, 1);
});

test("withRetry: re-throws the last error after exhausting attempts", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => { calls++; throw { code: "ETIMEDOUT" }; },
        { retries: 3, sleep: noSleep },
      ),
    (err: any) => err.code === "ETIMEDOUT",
  );
  assert.equal(calls, 3);
});

test("withTimeout: resolves fast operations, rejects slow ones", async () => {
  assert.equal(await withTimeout(async () => "fast", 1000), "fast");
  await assert.rejects(
    () => withTimeout(() => new Promise((r) => setTimeout(() => r("slow"), 50)), 5, "slowOp"),
    /timed out/,
  );
});
