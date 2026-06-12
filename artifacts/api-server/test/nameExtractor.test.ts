import { test } from "node:test";
import assert from "node:assert/strict";
import { applyNameSttCorrections, extractCustomerNameWithMeta } from "../src/lib/nameExtractor";

test("applyNameSttCorrections: fixes known STT mishearings", () => {
  assert.equal(applyNameSttCorrections("jan prakash bol raha hoon"), "Gyan Prakash bol raha hoon");
  assert.equal(applyNameSttCorrections("rushav naam hai"), "Rishabh naam hai");
});

test("extractCustomerNameWithMeta: extracts from Hinglish phrases", () => {
  const { name } = extractCustomerNameWithMeta("mera naam Amit hai");
  assert.equal(name, "Amit");
});

test("extractCustomerNameWithMeta: corrected names need confirmation", () => {
  const { name, needsConfirmation } = extractCustomerNameWithMeta("jan prakash");
  assert.equal(name, "Gyan Prakash");
  assert.equal(needsConfirmation, true);
});

test("extractCustomerNameWithMeta: rejects non-names", () => {
  const { name } = extractCustomerNameWithMeta("haan ji theek hai");
  assert.equal(name, null);
});
