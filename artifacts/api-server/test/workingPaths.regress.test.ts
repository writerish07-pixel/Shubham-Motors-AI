/**
 * Lock what already worked, plus call-18 Super vs Splendor.
 * Run on every change so greeting, transfer, EMI, WhatsApp, bikes, sticky model
 * cannot silently regress.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bargeInArmed,
  bargeInFramesNeeded,
  bargeInRmsThreshold,
  familiesMentioned,
  ttsLanguageCode,
} from "../src/lib/agentTools";
import {
  bargeEnergyHits,
  isCustomerAskingForHuman,
  peekHumanTransfer,
  queueHumanTransferTeam,
  resetHumanTransferStateForTests,
  resolveConnectNumbers,
} from "../src/lib/humanTransfer";
import {
  applyLiveModelSwitch,
  detectNamedModel,
  isGlamourFamily,
  liveModelForTurn,
} from "../src/lib/liveModel";
import { pickContextualFollowUp } from "../src/lib/salesFollowUp";
import { computeEmi, resolveModelOnRoad } from "../src/lib/emiQuote";
import { botspaceRequestOptions } from "../src/lib/whatsapp";
import { correctStt, tryDirectAnswer } from "../src/lib/modelRouter";
import {
  buildFollowUpCallPromptBlock,
  buildPurchaseVerificationGreeting,
} from "../src/lib/followUpCallContext";
import { formatDefaultHeroKnowledgeWithLiveEmi, kindForModelName } from "@workspace/db/heroCatalog";
import { evaluateAppRegression } from "@workspace/db/kbRegression";

test("regress: Connect does not dial sales unless a transfer was queued", () => {
  resetHumanTransferStateForTests();
  assert.deepEqual(
    resolveConnectNumbers({
      callSid: "silent-call",
      contacts: [{ type: "sales", isActive: true, phone: "9610165555", name: "Priyanka" }],
      fallback: "9610165555",
    }),
    [],
  );
});

test("regress: queued एजेंट handoff still dials the sales team", () => {
  resetHumanTransferStateForTests();
  assert.equal(isCustomerAskingForHuman("एजेंट से बात कराओ"), true);
  assert.equal(queueHumanTransferTeam("CA-ASK", [{ phone: "9610165555", name: "Priyanka" }]), true);
  assert.deepEqual(
    resolveConnectNumbers({ callSid: "CA-ASK", contacts: [] }),
    ["+919610165555"],
  );
  assert.equal(peekHumanTransfer("CA-ASK")?.label, "Priyanka");
});

test("regress: greeting barge-in stays disarmed for the whole namaste", () => {
  const now = 2_000_000;
  assert.equal(
    bargeInArmed({ isSpeaking: true, speakingStartedAt: now - 5000, greetingProtectedUntil: now + 20_000 }, now),
    false,
  );
  assert.ok(bargeInRmsThreshold() >= 0.04);
  assert.equal(bargeInFramesNeeded(), 12);
  assert.equal(bargeEnergyHits(0.03, 0.02, 0.048), false);
  assert.equal(bargeEnergyHits(0.13, 0.02, 0.048), true);
});

test("regress: TTS stays Hindi (Sarvam bulbul, not English IVR)", () => {
  assert.equal(ttsLanguageCode("en-IN"), "hi-IN");
  assert.equal(ttsLanguageCode("hi-IN"), "hi-IN");
});

test("regress: live EMI formula, no precomputed table", () => {
  const emi = computeEmi(100000, 24, 0.09);
  assert.ok(emi > 4500 && emi < 4700);
  const kb = formatDefaultHeroKnowledgeWithLiveEmi();
  assert.doesNotMatch(kb, /PRECOMPUTED EMI/);
  assert.match(kb, /\[LIVE EMI\]/);
  const app = evaluateAppRegression({
    costMode: "balanced",
    costBudgetInrPerMin: 4,
    defaultKnowledge: kb,
  });
  assert.ok(app.every((c) => c.ok), app.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`).join("; "));
});

test("regress: BotSpace auth is ?apiKey=", () => {
  const opts = botspaceRequestOptions("test-key");
  assert.equal(opts.params.apiKey, "test-key");
  assert.equal(opts.headers.Authorization, undefined);
});

test("regress: Glamour X and Super Splendor are bikes", () => {
  assert.equal(kindForModelName("Glamour X DSS"), "bike");
  assert.equal(kindForModelName("Super Splendor XTEC"), "bike");
  assert.equal(kindForModelName("Destini 125 ZX"), "scooter");
});

test("regress: call 17 sticky Glamour → HF Deluxe still wins", () => {
  const heard = correctStt("मैं एच एस डीलक्स प्रो देख रहा हूं।");
  assert.match(heard, /HF Deluxe/i);
  const named = detectNamedModel(heard) ?? detectNamedModel("मैं एचएफ डीलक्स के बारे में जानना चाहता हूं।");
  assert.match(named ?? "", /HF Deluxe/i);
  const sig = applyLiveModelSwitch(
    { interestedModel: "Glamour X DSS", segment: "125cc" },
    heard,
  );
  assert.match(sig.interestedModel ?? "", /HF Deluxe/i);
  assert.equal(sig.segment, "100cc");
  const q = pickContextualFollowUp({
    signals: { interestedModel: "Glamour X DSS", segment: "125cc" },
    customerText: "मैं एचएफ डीलक्स के बारे में जानना चाहता हूं।",
  });
  assert.doesNotMatch(q, /डी एस एस|DSS|क्रूज़ कंट्रोल वाला/);
  assert.equal(isGlamourFamily("HF Deluxe Pro"), false);
});

test("call 18: Super Splendor XTEC 2.0 Disc is Super Splendor, not Splendor+", () => {
  const uttered = "Super Splendor XTEC 2.0 Disc 125cc";
  const named = detectNamedModel(uttered);
  assert.match(named ?? "", /Super Splendor/i);
  assert.doesNotMatch(named ?? "", /^Splendor/);
  assert.equal(liveModelForTurn(uttered, "Glamour X DSS"), "Super Splendor XTEC");
  const families = familiesMentioned(uttered);
  assert.deepEqual(families, ["Super Splendor"]);
  const resolved = resolveModelOnRoad(uttered);
  assert.ok(resolved);
  assert.equal(resolved!.model, "Super Splendor XTEC");
  assert.equal(resolved!.onRoad, 98169);
  assert.notEqual(resolved!.onRoad, 97973);
});

test("call 18: Hindi सुपर स्प्लेंडर is not Splendor+ XTEC 2.0", () => {
  const heard = correctStt("मुझे सुपर स्प्लेंडर एक्सटेक दो पॉइंट ओ चाहिए");
  assert.match(heard, /Super Splendor/i);
  const named = detectNamedModel(heard);
  assert.match(named ?? "", /Super Splendor/i);
});

test("call 18: follow-up never asks Glamour DSS on Super Splendor", () => {
  const q = pickContextualFollowUp({
    signals: { interestedModel: "Glamour X DSS" },
    customerText: "Super Splendor XTEC 2.0 Disc देख रहा हूं",
  });
  assert.doesNotMatch(q, /डी एस एस|DSS|क्रूज़|DRS/);
  assert.match(q, /Super Splendor|टेस्ट राइड/);
});

test("plain Splendor / Splendor+ still maps to 100cc Splendor", () => {
  assert.equal(detectNamedModel("Splendor Plus देख रहा हूं"), "Splendor XTEC");
  assert.equal(detectNamedModel("स्प्लेंडर प्लस"), "Splendor XTEC");
  const resolved = resolveModelOnRoad("splendor plus xtec 2.0");
  assert.ok(resolved);
  assert.match(resolved!.model, /Splendor/);
  assert.doesNotMatch(resolved!.model, /Super/);
});

test("memory starts the call; this-turn mind-change overwrites", () => {
  assert.equal(liveModelForTurn("कुछ और देख रहा हूं, Super Splendor चाहिए", "Glamour X DSS"), "Super Splendor");
  const next = applyLiveModelSwitch(
    { interestedModel: "Glamour X DSS", segment: "125cc" },
    "वो नहीं, HF Deluxe देख रहा हूं",
  );
  assert.match(next.interestedModel ?? "", /HF Deluxe/i);
  const block = buildFollowUpCallPromptBlock(
    { name: "मोहन", interestedModel: "Glamour X DSS" },
    1,
    "last time Glamour",
  );
  assert.match(block, /START, NOT A LOCK|not a lock/i);
  const greeting = buildPurchaseVerificationGreeting("मोहन", "Glamour X DSS");
  assert.match(greeting, /कुछ और देख रहे हैं/);
});

test("named model follow-up is a showroom visit slot, not km discovery", () => {
  const q = pickContextualFollowUp({
    signals: { interestedModel: "Super Splendor XTEC" },
    customerText: "Super Splendor लेनी है",
  });
  assert.doesNotMatch(q, /किलोमीटर|स्कूटर चाहिए/);
  assert.match(q, /आज शाम|कल सुबह|टेस्ट राइड/);
});

test("never give up: co-dealer cheaper is Priyanka, not a fake discount", () => {
  const q = pickContextualFollowUp({
    signals: { interestedModel: "Super Splendor XTEC" },
    customerText: "dusre dealer kam de rahe",
  });
  assert.match(q, /सेल्स/);
  assert.doesNotMatch(q, /₹\d|मैं \d+ कम/);
});

test("cruise on Glamour still works; HF Deluxe still has no cruise", () => {
  const glamour = tryDirectAnswer("isme cruise control aata hai kya", "", "जी", {
    signals: { interestedModel: "Glamour X" },
    history: [{ role: "assistant", content: "ग्लैमर एक्स" }],
  });
  assert.ok(glamour);
  assert.match(glamour!, /क्रूज़ कंट्रोल/);
  const deluxe = tryDirectAnswer("HF Deluxe में क्रूज़ कंट्रोल आता है क्या", "", "जी", {
    signals: { interestedModel: "HF Deluxe" },
  });
  assert.ok(deluxe);
  assert.doesNotMatch(deluxe!, /डी एस एस में क्रूज़/);
});
