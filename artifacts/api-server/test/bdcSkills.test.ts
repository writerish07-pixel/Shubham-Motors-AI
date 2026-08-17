import { test } from "node:test";
import assert from "node:assert/strict";
import {
  alternativeClose,
  assumptiveVisitClose,
  isLiveBuyingQuestion,
  isStall,
  laerStallFollowUp,
  spinFollowUp,
  spinGap,
} from "../src/lib/bdcSkills";
import { pickContextualFollowUp } from "../src/lib/salesFollowUp";

test("SPIN: named model skips situation/km and goes to visit payoff", () => {
  assert.equal(spinGap({ interestedModel: "Super Splendor XTEC" }), "need_payoff");
  assert.match(spinFollowUp({ interestedModel: "Super Splendor XTEC" }, "Super Splendor XTEC"), /टेस्ट राइड|आज शाम|कल सुबह/);
  assert.doesNotMatch(spinFollowUp({ interestedModel: "Super Splendor XTEC" }, "Super Splendor XTEC"), /स्कूटर चाहिए|किलोमीटर/);
});

test("SPIN: unknown segment asks situation first", () => {
  assert.equal(spinGap({}), "situation");
  assert.match(spinFollowUp({}), /स्कूटर/);
  assert.match(spinFollowUp({}), /बाइक/);
});

test("LAER: stall is not 'जी सोचिए' — explore blocker then visit", () => {
  assert.equal(isStall("सोच के बताता हूँ"), true);
  assert.equal(isStall("emi kitni hogi"), false);
  const q = pickContextualFollowUp({
    signals: { interestedModel: "Super Splendor XTEC" },
    customerText: "सोच के बताता हूँ",
  });
  assert.match(q, /बजट|घर|ब्रांड/);
  assert.doesNotMatch(q, /स्कूटर चाहिए/);
  assert.match(laerStallFollowUp("HF Deluxe"), /HF Deluxe|ट्राई/);
});

test("answer the live question first: price is not a stall loop", () => {
  assert.equal(isLiveBuyingQuestion("Super Splendor की कीमत क्या है"), true);
  const q = pickContextualFollowUp({
    signals: { interestedModel: "Super Splendor XTEC" },
    customerText: "Super Splendor की कीमत क्या है",
  });
  assert.match(q, /टेस्ट राइड|आज|कल/);
  assert.doesNotMatch(q, /बजट, घर वाले/);
});

test("assumptive and alternative close name a day or channel", () => {
  assert.match(assumptiveVisitClose("Glamour X DSS"), /आज शाम|कल सुबह/);
  assert.match(alternativeClose("Glamour X DSS"), /वॉट्सऐप|शोरूम/);
});

test("call 17: stall must not revive Glamour DSS on HF Deluxe", () => {
  const q = pickContextualFollowUp({
    signals: { interestedModel: "Glamour X DSS" },
    customerText: "मैं एचएफ डीलक्स के बारे में जानना चाहता हूं। सोच के बताता हूँ",
  });
  assert.doesNotMatch(q, /डी एस एस|क्रूज़ कंट्रोल वाला/);
});
