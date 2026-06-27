import { test } from "node:test";
import assert from "node:assert/strict";
import { newTraceId, StageTimer } from "../src/lib/observability";

test("newTraceId: returns distinct uuid-shaped ids", () => {
  const a = newTraceId();
  const b = newTraceId();
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("StageTimer: aggregates per-stage timings with an injected clock", async () => {
  let clock = 1000;
  const timer = new StageTimer("trace-1", 2, () => clock);

  // stt: 1000 -> 1040 = 40ms
  await timer.time("stt", async () => { clock += 40; return "transcript"; }, "sarvam");
  // llm: 1040 -> 1240 = 200ms
  await timer.time("llm", async () => { clock += 200; return "reply"; });
  // tts: manual record
  timer.record("tts", 80, true, "sarvam");
  clock += 80;

  const report = timer.build({ conversationId: "call-9", customerId: 42 });
  assert.equal(report.traceId, "trace-1");
  assert.equal(report.turn, 2);
  assert.equal(report.conversationId, "call-9");
  assert.equal(report.customerId, 42);
  assert.equal(report.byStage.stt, 40);
  assert.equal(report.byStage.llm, 200);
  assert.equal(report.byStage.tts, 80);
  assert.equal(report.totalMs, 320);
  assert.equal(report.stages.length, 3);
  assert.equal(report.stages[0]?.via, "sarvam");
});

test("StageTimer: records a failed stage and re-throws", async () => {
  let clock = 0;
  const timer = new StageTimer("trace-2", 0, () => clock);
  await assert.rejects(
    () => timer.time("tts", async () => { clock += 10; throw new Error("tts down"); }, "sarvam"),
    /tts down/,
  );
  const report = timer.build();
  assert.equal(report.stages.length, 1);
  assert.equal(report.stages[0]?.ok, false);
  assert.equal(report.stages[0]?.stage, "tts");
});
