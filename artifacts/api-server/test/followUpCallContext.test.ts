import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPurchaseVerificationGreeting, isFollowUpCall } from "../src/lib/followUpCallContext";

test("follow-up greeting is Devanagari Hindi so hi-IN TTS does not stay silent/English", () => {
  const g = buildPurchaseVerificationGreeting("Rahul", "Splendor XTEC");
  assert.match(g, /नमस्ते/);
  assert.match(g, /साक्षी/);
  assert.match(g, /Rahul/);
  assert.match(g, /Splendor XTEC/);
  assert.match(g, /कुछ और देख रहे हैं/);
  assert.equal(/Namaste|Main Sakshi/.test(g), false);
});

test("returning callers and outbound are follow-ups", () => {
  assert.equal(isFollowUpCall(1, false), true);
  assert.equal(isFollowUpCall(0, true), true);
  assert.equal(isFollowUpCall(0, false), false);
});
