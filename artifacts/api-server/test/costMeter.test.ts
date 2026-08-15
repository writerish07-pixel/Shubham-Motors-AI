import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateCallCost, type CostRates } from "../src/lib/costMeter";

const rates: CostRates = {
  usdInr: 85,
  exotelInboundPerMin: 0.6,
  exotelOutboundPerMin: 0.9,
  sarvamSttPerHour: 30,
  sarvamTtsPer10kChars: 15,
  miniInputUsdPer1M: 0.15,
  miniOutputUsdPer1M: 0.6,
  premiumInputUsdPer1M: 2.5,
  premiumOutputUsdPer1M: 10,
};

test("₹2 cap: typical 3-min outbound with mini + Sarvam stays under budget", () => {
  const c = estimateCallCost(
    {
      durationSec: 180,
      direction: "outbound",
      sttAudioSec: 40,
      ttsChars: 900,
      llmMiniCalls: 6,
      llmPremiumCalls: 0,
    },
    rates,
  );
  assert.equal(c.overBudget, false);
  assert.ok(c.perMinInr <= 2, `perMin ${c.perMinInr} should be <= 2`);
});

test("₹2 cap: same call on gpt-4o premium exceeds budget", () => {
  const c = estimateCallCost(
    {
      durationSec: 180,
      direction: "outbound",
      sttAudioSec: 40,
      ttsChars: 900,
      llmMiniCalls: 0,
      llmPremiumCalls: 6,
    },
    rates,
  );
  assert.equal(c.overBudget, true);
  assert.ok(c.llmInr > 2, "premium LLM alone should blow the per-call cap");
});

test("inbound is cheaper than outbound at the same duration", () => {
  const base = {
    durationSec: 60,
    sttAudioSec: 15,
    ttsChars: 300,
    llmMiniCalls: 2,
    llmPremiumCalls: 0,
  };
  const inb = estimateCallCost({ ...base, direction: "inbound" }, rates);
  const out = estimateCallCost({ ...base, direction: "outbound" }, rates);
  assert.ok(inb.perMinInr < out.perMinInr);
});
