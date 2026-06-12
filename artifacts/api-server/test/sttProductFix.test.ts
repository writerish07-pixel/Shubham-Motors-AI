import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeProductStt,
  isCruiseControlQuestion,
  mentionsGlamour,
  isFeatureAvailabilityQuestion,
} from "../src/lib/sttProductFix";

test("normalizeProductStt: fixes garbled Glamour", () => {
  assert.equal(normalizeProductStt("galemar ke baare mein batao"), "Glamour ke baare mein batao");
  assert.equal(normalizeProductStt("glaimer 125 hai kya"), "Glamour 125 hai kya");
});

test("normalizeProductStt: fixes garbled cruise control", () => {
  assert.match(normalizeProductStt("isme kul santro lata hai kya"), /cruise control/);
});

test("isCruiseControlQuestion: STT variants detected", () => {
  assert.equal(isCruiseControlQuestion("cruise control aata hai?"), true);
  assert.equal(isCruiseControlQuestion("santro lata hai kya"), true);
  assert.equal(isCruiseControlQuestion("mileage kitni hai"), false);
});

test("mentionsGlamour: catches model and garbled forms", () => {
  assert.equal(mentionsGlamour("Glamour X dikhao"), true);
  assert.equal(mentionsGlamour("galemar kaisi hai"), true);
  assert.equal(mentionsGlamour("Splendor chahiye"), false);
});

test("isFeatureAvailabilityQuestion: detects aata hai / milta hai forms", () => {
  assert.equal(isFeatureAvailabilityQuestion("isme cruise aata hai kya"), true);
  assert.equal(isFeatureAvailabilityQuestion("price batao"), false);
});
