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

test("₹4 cap: typical 3-min outbound with mini + Sarvam stays under budget", () => {
  const prev = process.env.COST_ALERT_INR_PER_MIN;
  process.env.COST_ALERT_INR_PER_MIN = "4";
  try {
    const c = estimateCallCost(
      {
        durationSec: 180,
        direction: "outbound",
        sttAudioSec: 40,
        ttsChars: 900,
        llmMiniCalls: 6,
        llmPremiumCalls: 1,
      },
      rates,
    );
    assert.equal(c.overBudget, false);
    assert.ok(c.perMinInr <= 4, `perMin ${c.perMinInr} should be <= 4`);
  } finally {
    if (prev === undefined) delete process.env.COST_ALERT_INR_PER_MIN;
    else process.env.COST_ALERT_INR_PER_MIN = prev;
  }
});

test("₹4 cap: 6 gpt-4o premium turns on a short call exceeds budget", () => {
  const prev = process.env.COST_ALERT_INR_PER_MIN;
  process.env.COST_ALERT_INR_PER_MIN = "4";
  try {
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
    assert.ok(c.llmInr > 2, "premium LLM alone should be material");
  } finally {
    if (prev === undefined) delete process.env.COST_ALERT_INR_PER_MIN;
    else process.env.COST_ALERT_INR_PER_MIN = prev;
  }
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
