import { test } from "node:test";
import assert from "node:assert/strict";
import { HERO_VARIANTS, ON_ROAD_JAIPUR, knowledgeSeedRows, formatDefaultHeroKnowledge, formatDefaultHeroKnowledgeWithLiveEmi, kindForModelName, sanitizeIntentSummary } from "@workspace/db/heroCatalog";
import { ON_ROAD_JAIPUR as EMI_PRICES } from "../src/lib/emiQuote";
import { pickThinkingFiller } from "../src/lib/voiceFastPath";
import { sanitizeAgentSpeech, prepareTtsText } from "../src/lib/ttsPrep";

test("catalog has priced commuters and premium models without fake rupees", () => {
  assert.equal(ON_ROAD_JAIPUR["Glamour X DRS"], 104555);
  assert.equal(ON_ROAD_JAIPUR["Splendor XTEC"], 95377);
  assert.equal(EMI_PRICES["Glamour X DRS"], 104555);
  const xpulse = HERO_VARIANTS.find((v) => v.name === "Xpulse 210");
  assert.ok(xpulse);
  assert.equal(xpulse!.onRoadJaipur, null);
  assert.match(formatDefaultHeroKnowledge(), /Karizma XMR/);
  assert.match(formatDefaultHeroKnowledge(), /Vida V1 Pro/);
  const withEmi = formatDefaultHeroKnowledgeWithLiveEmi();
  assert.match(withEmi, /\[LIVE EMI\]/);
  assert.doesNotMatch(withEmi, /PRECOMPUTED EMI/);
});

test("knowledge seed covers every family plus showroom/offers", () => {
  const rows = knowledgeSeedRows();
  const titles = new Set(rows.map((r) => r.title));
  assert.ok(titles.has("Shubham Motors showroom"));
  assert.ok(titles.has("Glamour X"));
  assert.ok(titles.has("Vida"));
  assert.ok(rows.length >= 20);
});

test("thinking filler is silent on small talk", () => {
  assert.equal(pickThinkingFiller("namaste", 0), "");
  assert.equal(pickThinkingFiller("splendor dekhna hai", 3), "");
  assert.ok(pickThinkingFiller("emi kitna hoga", 3).length > 0);
});

test("sanitizeAgentSpeech strips stacked ji/achha", () => {
  assert.equal(sanitizeAgentSpeech("Ji sir, bilkul, Splendor theek rahegi."), "Splendor theek rahegi.");
  assert.match(prepareTtsText("Ji, Splendor XTEC ki mileage 80 kmpl hai."), /स्प्लेंडर/);
});

test("prepareTtsText strips catalog lists so TTS does not read asterisks or one-two-three", () => {
  const spoken = prepareTtsText(
    "हमारे पास 100 सीसी में ये मॉडल्स हैं: 1. **HF Deluxe** — 83 kmpl। 2. **Splendor Plus** — 80 kmpl।",
  );
  assert.doesNotMatch(spoken, /\*\*/);
  assert.doesNotMatch(spoken, /\b1\./);
  assert.doesNotMatch(spoken, /\b2\./);
  assert.match(spoken, /एच एफ डिलक्स/);
  assert.match(spoken, /स्प्लेंडर प्लस/);
  assert.match(spoken, /किलोमीटर प्रति लीटर/);
});

test("prepareTtsText clips a late-call catalog dump at a Hindi sentence, not mid-word", () => {
  const dump = "हमारे पास ये हैं। " + "स्प्लेंडर प्लस एक्सटेक, एच एफ डिलक्स, ग्लैमर एक्स, एक्सट्रीम, करिज़्मा, डेस्टिनी, प्लेज़र, ज़ूम, विडा, और और मॉडल। ".repeat(8);
  const spoken = prepareTtsText(dump);
  assert.ok(spoken.length <= 260);
  assert.ok(spoken.endsWith("।") || spoken.length < 80);
});

test("Glamour X and Super Splendor are bikes, Destini is a scooter", () => {
  assert.equal(kindForModelName("Glamour X DSS"), "bike");
  assert.equal(kindForModelName("Super Splendor"), "bike");
  assert.equal(kindForModelName("Destini 125 ZX"), "scooter");
});

test("sanitizeIntentSummary: call-9 must not call Glamour a scooter", () => {
  const raw = "The customer, Shivay, is very interested in purchasing a scooter, specifically the 'Glamour X DSS' or 'Super Splendor'.";
  const fixed = sanitizeIntentSummary(raw, "Glamour X DSS");
  assert.match(fixed, /bike/i);
  assert.doesNotMatch(fixed, /purchasing a scooter/i);
});
