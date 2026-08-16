import { test } from "node:test";
import assert from "node:assert/strict";
import { HERO_VARIANTS, ON_ROAD_JAIPUR, knowledgeSeedRows, formatDefaultHeroKnowledge, formatDefaultHeroKnowledgeWithLiveEmi } from "@workspace/db/heroCatalog";
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
