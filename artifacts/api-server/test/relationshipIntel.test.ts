import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeLeadIntelligence,
  derivePurchaseStage,
  inferCustomerPersona,
  computePurchaseProbability,
  estimateExpectedRevenue,
  type IntelligenceInput,
} from "../src/lib/relationshipIntel";

const base: IntelligenceInput = {
  intent: "interested",
  callScore: 50,
  completedCalls: 1,
};

test("derivePurchaseStage: picks the most advanced signal", () => {
  assert.equal(derivePurchaseStage({ ...base, negotiating: true }), "negotiation");
  assert.equal(derivePurchaseStage({ ...base, intent: "hot_buy" }), "ready");
  assert.equal(derivePurchaseStage({ ...base, readyToBuy: true }), "ready");
  assert.equal(derivePurchaseStage({ ...base, visitPlanned: true }), "evaluation");
  assert.equal(derivePurchaseStage({ ...base, competitorMentioned: "TVS" }), "comparison");
  assert.equal(derivePurchaseStage(base), "exploration");
  // negotiation outranks a co-occurring comparison signal
  assert.equal(
    derivePurchaseStage({ ...base, negotiating: true, competitorMentioned: "Bajaj" }),
    "negotiation",
  );
  // an existing converted owner returning is a repeat opportunity
  assert.equal(derivePurchaseStage({ ...base, priorStatus: "converted" }), "repeat");
});

test("inferCustomerPersona: maps signals to sales strategy", () => {
  assert.equal(inferCustomerPersona({ ...base, purpose: "business" }), "business_buyer");
  assert.equal(inferCustomerPersona({ ...base, familyUse: true }), "family_buyer");
  assert.equal(inferCustomerPersona({ ...base, stylePreference: "sporty" }), "performance_buyer");
  assert.equal(inferCustomerPersona({ ...base, segment: "160cc+" }), "performance_buyer");
  assert.equal(inferCustomerPersona({ ...base, negotiating: true }), "price_sensitive");
  assert.equal(inferCustomerPersona({ ...base, dailyKm: 60 }), "mileage_sensitive");
  assert.equal(inferCustomerPersona({ ...base, budget: 180000 }), "status_sensitive");
  assert.equal(inferCustomerPersona({ ...base, segment: "scooter_125" }), "comfort_buyer");
  assert.equal(inferCustomerPersona({ ...base, interestedModel: "Glamour X DSS ABS" }), "safety_buyer");
});

test("computePurchaseProbability: anchored on intent, adjusted by timeline", () => {
  // lost / wrong number are zeroed
  assert.equal(computePurchaseProbability({ ...base, lostDeal: true }), 0);
  assert.equal(computePurchaseProbability({ ...base, intent: "wrong_number" }), 0);
  // not_interested is capped low
  assert.ok(computePurchaseProbability({ ...base, intent: "not_interested", callScore: 90 }) <= 5);
  // immediate timeline + ready + visit lifts a warm lead above its raw score
  const hot = computePurchaseProbability({
    ...base,
    callScore: 70,
    buyingTimeline: "immediate",
    readyToBuy: true,
    visitPlanned: true,
  });
  assert.ok(hot > 70 && hot <= 98, `expected boosted probability, got ${hot}`);
  // next_year pushes it down
  assert.ok(
    computePurchaseProbability({ ...base, callScore: 70, buyingTimeline: "next_year" }) < 70,
  );
});

test("estimateExpectedRevenue: probability-weighted, uses segment fallback price", () => {
  // 125cc fallback price 100000 at 50% probability → 50000
  assert.equal(estimateExpectedRevenue({ ...base, segment: "125cc" }, 50), 50000);
  // explicit vehicle price wins over the segment estimate
  assert.equal(estimateExpectedRevenue({ ...base, vehiclePrice: 120000 }, 25), 30000);
  assert.equal(estimateExpectedRevenue(base, 0), 0);
});

test("computeLeadIntelligence: produces a coherent bounded patch", () => {
  const patch = computeLeadIntelligence({
    intent: "hot_buy",
    callScore: 85,
    buyingTimeline: "immediate",
    readyToBuy: true,
    visitPlanned: true,
    financeInterest: true,
    segment: "125cc",
    currentVehicle: "Splendor", // Hero owner → loyalty
    completedCalls: 2,
    priorStatus: "interested",
  });

  for (const key of [
    "relationshipScore", "trustScore", "engagementScore",
    "loyaltyScore", "followupScore", "purchaseProbability",
  ] as const) {
    assert.ok(patch[key] >= 0 && patch[key] <= 100, `${key} out of range: ${patch[key]}`);
  }
  assert.equal(patch.purchaseStage, "ready");
  assert.ok(patch.loyaltyScore >= 40, "Hero owner should have meaningful loyalty");
  assert.ok(patch.expectedRevenue > 0);
  assert.ok(patch.lifetimeValue > patch.expectedRevenue, "LTV should exceed single-sale revenue");
});

test("computeLeadIntelligence: a dead lead scores near zero with no revenue", () => {
  const patch = computeLeadIntelligence({
    intent: "not_interested",
    callScore: 10,
    completedCalls: 1,
    lostDeal: false,
  });
  assert.ok(patch.purchaseProbability <= 5);
  assert.ok(patch.expectedRevenue < 6000, `expected near-zero revenue, got ${patch.expectedRevenue}`);
  assert.equal(patch.purchaseStage, "exploration");
});
