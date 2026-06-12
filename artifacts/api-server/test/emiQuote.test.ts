import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeEmi,
  parseDownPayment,
  parseTenureMonths,
  resolveModelOnRoad,
  formatEmiQuote,
  ON_ROAD_JAIPUR,
} from "../src/lib/emiQuote";

test("computeEmi: uses the 9% factor table", () => {
  assert.equal(computeEmi(100000, 24), Math.round(100000 * 0.045685));
  assert.equal(computeEmi(0, 24), 0);
});

test("parseDownPayment: lakh / hajar / plain forms", () => {
  assert.equal(parseDownPayment("1 lakh down dunga"), 100000);
  assert.equal(parseDownPayment("25 hajar de sakta hoon"), 25000);
  assert.equal(parseDownPayment("down payment 30,000"), 30000);
  assert.equal(parseDownPayment("bike chahiye"), null);
});

test("parseTenureMonths: spoken tenures", () => {
  assert.equal(parseTenureMonths("36 mahine ka karo"), 36);
  assert.equal(parseTenureMonths("do saal ki EMI"), 24);
  assert.equal(parseTenureMonths("ek saal mein chukana hai"), 12);
  assert.equal(parseTenureMonths("emi batao"), null);
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

test("formatEmiQuote: includes tenure and reference-rate disclaimer", () => {
  const q = formatEmiQuote("Glamour X DRS", 104555, 25000, 24);
  assert.match(q, /24 mahine/);
  assert.match(q, /9%/);
  assert.match(q, /CIBIL/);
});
