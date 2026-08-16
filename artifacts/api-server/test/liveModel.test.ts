import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyLiveModelSwitch,
  detectNamedModel,
  isGlamourFamily,
  isRejectingPreviousModel,
  liveModelForTurn,
} from "../src/lib/liveModel";
import { pickContextualFollowUp, getMissingFollowUpSentence } from "../src/lib/salesFollowUp";
import { tryDirectAnswer, correctStt } from "../src/lib/modelRouter";

test("call 17: rejecting Glamour is not Glamour interest", () => {
  const text = "मगर ग्लैमर एक्स नहीं देखी, मैं कुछ और देख रहा हूं।";
  assert.equal(isRejectingPreviousModel(text), true);
  assert.equal(detectNamedModel(text), null);
  const next = applyLiveModelSwitch(
    { interestedModel: "Glamour X DSS", segment: "125cc" },
    text,
  );
  assert.equal(next.interestedModel, undefined);
  assert.equal(liveModelForTurn(text, "Glamour X DSS"), "");
});

test("call 17: Devanagari HF Deluxe Pro becomes this-call model", () => {
  const heard = correctStt("मैं एच एस डीलक्स प्रो देख रहा हूं।");
  assert.match(heard, /HF Deluxe/i);
  const named = detectNamedModel(heard) ?? detectNamedModel("मैं एच एस डीलक्स प्रो देख रहा हूं।");
  assert.ok(named);
  assert.match(named!, /HF Deluxe/i);
  const sig = applyLiveModelSwitch(
    { interestedModel: "Glamour X DSS", segment: "125cc" },
    heard,
  );
  assert.match(sig.interestedModel ?? "", /HF Deluxe/i);
  assert.equal(sig.segment, "100cc");
});

test("call 17: follow-up must not ask Glamour DSS vs DRS on HF Deluxe", () => {
  const q = pickContextualFollowUp({
    signals: { interestedModel: "Glamour X DSS", segment: "125cc" },
    customerText: "मैं एचएफ डीलक्स के बारे में जानना चाहता हूं।",
  });
  assert.doesNotMatch(q, /डी एस एस|DSS|क्रूज़ कंट्रोल वाला/);
  assert.match(q, /डिलक्स|Deluxe|टेस्ट राइड|ऑन-रोड|ई एम आई/i);
});

test("call 17: appended follow-up stays on HF Deluxe after a mileage line", () => {
  const extra = getMissingFollowUpSentence(
    "एच एफ डिलक्स प्रो एक बेहतरीन विकल्प है, शिवाय जी। यह आरामदायक सीट और बेहतर ग्राफिक्स के साथ आती है।",
    {
      signals: { interestedModel: "Glamour X DSS" },
      customerText: "मैं एच एस डीलक्स प्रो देख रहा हूं।",
    },
  );
  assert.ok(extra);
  assert.doesNotMatch(extra!, /डी एस एस|क्रूज़ कंट्रोल वाला/);
});

test("Glamour cruise question still fires when THIS call model is Glamour", () => {
  const q = pickContextualFollowUp({
    signals: { interestedModel: "Glamour X DSS" },
    customerText: "ग्लैमर एक्स में क्रूज़ आता है क्या",
  });
  assert.match(q, /डी एस एस|डी आर एस/);
});

test("tryDirectAnswer: greeting history Glamour must not steal an HF Deluxe cruise turn", () => {
  const reply = tryDirectAnswer("HF Deluxe में क्रूज़ कंट्रोल आता है क्या", "", "जी", {
    signals: { interestedModel: "HF Deluxe" },
    history: [{ role: "assistant", content: "नमस्ते! क्या आपने Glamour X ले ली?" }],
  });
  assert.ok(reply);
  assert.doesNotMatch(reply, /डी एस एस में क्रूज़/);
  assert.match(reply, /HF Deluxe|एच एफ/);
});

test("liveModelForTurn: last named model wins over stale CRM", () => {
  assert.equal(liveModelForTurn("HF Deluxe Pro देख रहा हूं", "Glamour X DSS"), "HF Deluxe Pro");
  assert.equal(isGlamourFamily("Glamour X DSS"), true);
  assert.equal(isGlamourFamily("HF Deluxe Pro"), false);
});

test("reject Splendor, keep Destini — not Glamour-only", () => {
  const text = "स्प्लेंडर नहीं देखी, Destini देख रहा हूं";
  assert.match(detectNamedModel(text) ?? "", /Destini/i);
  const next = applyLiveModelSwitch({ interestedModel: "Splendor XTEC", segment: "100cc" }, text);
  assert.match(next.interestedModel ?? "", /Destini/i);
  assert.equal(next.segment, "scooter_110");
});

test("HF Deluxe then not Glamour keeps Deluxe — does not wipe the new model", () => {
  const text = "ग्लैमर की बात नहीं कर रहा हूं";
  const next = applyLiveModelSwitch({ interestedModel: "HF Deluxe Pro", segment: "100cc" }, text);
  assert.match(next.interestedModel ?? "", /HF Deluxe/i);
  assert.equal(next.segment, "100cc");
});

test("named model skips km discovery — conversion close", () => {
  const q = pickContextualFollowUp({
    signals: { interestedModel: "Glamour X DSS" },
    customerText: "स्प्लेंडर प्लस देख रहा हूं",
  });
  assert.doesNotMatch(q, /किलोमीटर|स्कूटर चाहिए/);
  assert.match(q, /Splendor|स्प्लेंडर|ऑन-रोड|टेस्ट राइड|ई एम आई/i);
});
