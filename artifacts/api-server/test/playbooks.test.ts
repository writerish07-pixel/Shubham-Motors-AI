import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isStaleEmiPlaybook,
  LIVE_EMI_PLAYBOOK,
  PLAYBOOKS,
  REWRITE_STALE_EMI_SQL,
} from "@workspace/db/playbooks";

test("playbooks ship Live EMI, not the old without-math card", () => {
  const titles = PLAYBOOKS.map((p) => p.title);
  assert.ok(titles.includes("Live EMI"));
  assert.ok(titles.includes("Never give up"));
  assert.ok(titles.includes("Xtreme 125R variants"));
  assert.ok(titles.includes("Cash discount to Priyanka"));
  assert.ok(!titles.some((t) => /without math/i.test(t)));
  for (const p of PLAYBOOKS) {
    assert.ok(!isStaleEmiPlaybook(p.title, p.content), `${p.title} still looks stale`);
    assert.doesNotMatch(p.content, /PRECOMPUTED EMI/i);
    assert.doesNotMatch(p.content, /Kabhi calculate mat karo/i);
  }
  assert.match(LIVE_EMI_PLAYBOOK.content, /\[EMI:Model\|down\|months\]/);
});

test("isStaleEmiPlaybook catches leftover seed copy", () => {
  assert.equal(
    isStaleEmiPlaybook(
      "EMI without math",
      "Kabhi calculate mat karo. [PRECOMPUTED EMI TABLE] se tenure ke saath padho.",
    ),
    true,
  );
  assert.equal(isStaleEmiPlaybook(LIVE_EMI_PLAYBOOK.title, LIVE_EMI_PLAYBOOK.content), false);
  assert.equal(isStaleEmiPlaybook("Test-ride close", "Price/EMI ke baad seedha slot"), false);
});

test("rewrite SQL targets the leftover playbook card", () => {
  assert.match(REWRITE_STALE_EMI_SQL, /EMI without math/i);
  assert.match(REWRITE_STALE_EMI_SQL, /PRECOMPUTED EMI/i);
  assert.match(REWRITE_STALE_EMI_SQL, /category = 'playbook'/);
});
