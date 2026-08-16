import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bargeEnergyHits,
  isCustomerAskingForHuman,
  normalizeAgentPhone,
  queueHumanTransfer,
  takeHumanTransfer,
} from "../src/lib/humanTransfer";
import { tryDirectAnswer } from "../src/lib/modelRouter";
import { prepareTtsText } from "../src/lib/ttsPrep";

test("isCustomerAskingForHuman: Hindi handoff, not EMI questions", () => {
  assert.equal(isCustomerAskingForHuman("kisi se baat karao"), true);
  assert.equal(isCustomerAskingForHuman("agent se baat karni hai"), true);
  assert.equal(isCustomerAskingForHuman("insaan se baat karao"), true);
  assert.equal(isCustomerAskingForHuman("transfer karo"), true);
  assert.equal(isCustomerAskingForHuman("emi kitni hogi 24 month"), false);
  assert.equal(isCustomerAskingForHuman("finance ke baare mein batao"), false);
});

test("queueHumanTransfer normalises 10-digit mobile", () => {
  assert.equal(normalizeAgentPhone("9876543210"), "+919876543210");
  assert.equal(queueHumanTransfer("CA1", "9876543210", "Ramesh"), true);
  assert.equal(takeHumanTransfer("CA1")?.phone, "+919876543210");
  assert.equal(takeHumanTransfer("CA1"), undefined);
});

test("bargeEnergyHits: loud speech beats echo floor", () => {
  assert.equal(bargeEnergyHits(0.08, 0.02, 0.024), true);
  assert.equal(bargeEnergyHits(0.02, 0.02, 0.024), false);
});

test("tryDirectAnswer: Glamour cruise is spoken Hindi, not Latin IVR", () => {
  const reply = tryDirectAnswer("isme cruise control aata hai kya", "", "जी", {
    signals: { interestedModel: "Glamour X" },
    history: [{ role: "assistant", content: "ग्लैमर एक्स" }],
  });
  assert.ok(reply);
  assert.match(reply, /क्रूज़ कंट्रोल/);
  assert.doesNotMatch(reply, /variant mein cruise control hai/);
});

test("prepareTtsText keeps a cruise line in Hindi accent", () => {
  const spoken = prepareTtsText(
    "Glamour X DSS variant mein cruise control hai — DRS variant mein nahi hota. Highway ride comfortable rehti hai.",
  );
  assert.match(spoken, /ग्लैमर/);
  assert.match(spoken, /क्रूज़ कंट्रोल|क्रूज़/);
  assert.doesNotMatch(spoken, /comfortable|highway ride/i);
});
