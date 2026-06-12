import { test } from "node:test";
import assert from "node:assert/strict";
import { extractBuyingTimeline, buyingTimelineQuestion } from "../src/lib/buyingTimeline";

test("extractBuyingTimeline: maps customer phrases to timeline enums", () => {
  assert.equal(extractBuyingTimeline("aaj hi lena hai"), "immediate");
  assert.equal(extractBuyingTimeline("is hafte le lenge"), "immediate");
  assert.equal(extractBuyingTimeline("15 din mein decide karenge"), "15days");
  assert.equal(extractBuyingTimeline("agle mahine salary ke baad"), "month");
  assert.equal(extractBuyingTimeline("diwali pe lenge"), "festival");
  assert.equal(extractBuyingTimeline("purana loan band hone ke baad"), "loan_closure");
  assert.equal(extractBuyingTimeline("agle saal sochenge"), "next_year");
});

test("extractBuyingTimeline: unrelated text returns null", () => {
  assert.equal(extractBuyingTimeline("Splendor ki price kya hai"), null);
});

test("buyingTimelineQuestion: includes the model when known", () => {
  assert.match(buyingTimelineQuestion("Glamour X"), /Glamour X/);
  assert.match(buyingTimelineQuestion(), /kab tak/i);
});
