import { test } from "node:test";
import assert from "node:assert/strict";
import { endsWithQuestion, ensureSalesFollowUp, pickContextualFollowUp } from "../src/lib/salesFollowUp";

test("endsWithQuestion: trailing question mark", () => {
  assert.equal(endsWithQuestion("Test ride kab convenient hoga?"), true);
});

test("endsWithQuestion: question mark mid-reply counts (no double questions)", () => {
  // The busy fast-path reply — question early, statement at the end.
  assert.equal(endsWithQuestion("कोई बात नहीं — aap kab free rahenge? Main tab call karungi."), true);
});

test("endsWithQuestion: Hinglish interrogative without question mark", () => {
  assert.equal(endsWithQuestion("Aap kaunsa variant dekh rahe hain"), true);
});

test("endsWithQuestion: plain statement is not a question", () => {
  assert.equal(endsWithQuestion("Splendor ki mileage 80 kmpl hai."), false);
});

test("ensureSalesFollowUp: passes [TRANSFER] tags through untouched", () => {
  const tag = "[TRANSFER] customer asked for sales person";
  assert.equal(ensureSalesFollowUp(tag, {}), tag);
});

test("ensureSalesFollowUp: appends exactly one question to a dead-end reply", () => {
  const out = ensureSalesFollowUp("Splendor ki mileage 80 kmpl hai.", { signals: {} });
  assert.notEqual(out, "Splendor ki mileage 80 kmpl hai.");
  assert.equal((out.match(/\?/g) ?? []).length, 1);
});

test("ensureSalesFollowUp: never stacks a second question", () => {
  const reply = "Glamour X DSS mein cruise control hai. Aap DSS dekhna chahenge ya DRS?";
  assert.equal(ensureSalesFollowUp(reply, { signals: {} }), reply);
});

test("pickContextualFollowUp: finance context asks for down payment", () => {
  const q = pickContextualFollowUp({ signals: { financeInterest: true }, customerText: "finance karwana hai" });
  assert.match(q.toLowerCase(), /down payment/);
});

test("pickContextualFollowUp: no segment known asks scooter vs bike first", () => {
  const q = pickContextualFollowUp({ signals: {}, customerText: "" });
  assert.match(q.toLowerCase(), /scooter|bike/);
});
