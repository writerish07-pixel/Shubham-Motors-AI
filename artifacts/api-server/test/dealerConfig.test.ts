import { test } from "node:test";
import assert from "node:assert/strict";
import { dealerConfig } from "../src/lib/dealerConfig";

test("dealerConfig defaults to Shubham Motors Jaipur", () => {
  const d = dealerConfig({});
  assert.equal(d.name, "Shubham Motors");
  assert.equal(d.city, "Jaipur");
  assert.match(d.address, /Lal Kothi/);
});

test("dealerConfig reads env overrides", () => {
  const d = dealerConfig({ DEALER_NAME: "Test Motors", DEALER_CITY: "Kota", DEALER_ADDRESS: "MI Road" });
  assert.equal(d.name, "Test Motors");
  assert.equal(d.city, "Kota");
  assert.equal(d.address, "MI Road");
});
