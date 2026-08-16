import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeEmi,
  parseDownPayment,
  parseTenureMonths,
  parseAnnualRate,
  resolveModelOnRoad,
  formatEmiQuote,
  ON_ROAD_JAIPUR,
} from "../src/lib/emiQuote";

test("computeEmi: live reducing-balance formula (not a lookup table)", () => {
  const emi = computeEmi(100000, 24, 0.09);
  const r = 0.09 / 12;
  const pow = Math.pow(1 + r, 24);
  const expected = Math.round(100000 * (r * pow) / (pow - 1));
  assert.equal(emi, expected);
  assert.ok(emi > 4500 && emi < 4700);
  assert.equal(computeEmi(0, 24), 0);
  assert.notEqual(computeEmi(100000, 30, 0.09), computeEmi(100000, 24, 0.09));
  assert.ok(computeEmi(100000, 24, 0.085) < computeEmi(100000, 24, 0.12));
});

test("parseDownPayment: lakh / hajar / plain forms", () => {
  assert.equal(parseDownPayment("1 lakh down dunga"), 100000);
  assert.equal(parseDownPayment("25 hajar de sakta hoon"), 25000);
  assert.equal(parseDownPayment("down payment 30,000"), 30000);
  assert.equal(parseDownPayment("अगर मैं ₹35000 का डाउन पेमेंट देता हूं"), 35000);
  assert.equal(parseDownPayment("bike chahiye"), null);
});

test("parseTenureMonths: spoken tenures", () => {
  assert.equal(parseTenureMonths("36 mahine ka karo"), 36);
  assert.equal(parseTenureMonths("do saal ki EMI"), 24);
  assert.equal(parseTenureMonths("ek saal mein chukana hai"), 12);
  assert.equal(parseTenureMonths("emi batao"), null);
});

test("parseAnnualRate: percent phrases", () => {
  assert.equal(parseAnnualRate("10 percent pe karo"), 0.1);
  assert.equal(parseAnnualRate("11% interest"), 0.11);
  assert.equal(parseAnnualRate("emi batao"), null);
});

test("resolveModelOnRoad: aliases including STT-garbled Glamour", () => {
  const glamour = resolveModelOnRoad("glamour ki emi batao");
  assert.ok(glamour);
  assert.equal(glamour!.model, "Glamour X DRS");
  assert.equal(glamour!.onRoad, ON_ROAD_JAIPUR["Glamour X DRS"]);

  const garbled = resolveModelOnRoad("galemar lena hai");
  assert.ok(garbled);
  assert.equal(garbled!.model, "Glamour X DRS");

  assert.equal(resolveModelOnRoad("koi bhi nahi"), null);
});

test("formatEmiQuote: spoken Hindi with tenure and CIBIL band — not Latin IVR", () => {
  const q = formatEmiQuote("Glamour X DRS", 104555, 25000, 24);
  assert.match(q, /ई एम आई/);
  assert.match(q, /सिबिल/);
  assert.match(q, /24 महीने/);
  assert.doesNotMatch(q, /live EMI|reducing balance|\/month @/);
  const devanagari = (q.match(/[\u0900-\u097F]/g) || []).length;
  assert.ok(devanagari > 40, q);
});
