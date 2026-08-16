import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDefaultHeroKnowledgeWithLiveEmi, HERO_CATALOG_SOURCE, knowledgeSeedRows } from "@workspace/db/heroCatalog";
import {
  compileReport,
  evaluateAppRegression,
  evaluateKbRegression,
  evaluateSchemaRegression,
  REQUIRED_CALL_COLUMNS,
  REQUIRED_LEAD_COLUMNS,
} from "@workspace/db/kbRegression";
import { LIVE_EMI_PLAYBOOK, PLAYBOOKS } from "@workspace/db/playbooks";

test("schema regression flags missing 10/10 columns", () => {
  const missing = evaluateSchemaRegression({ leads: ["id"], calls: ["id"] });
  assert.ok(missing.some((c) => !c.ok && c.id === "db.leads.locality"));
  const present = evaluateSchemaRegression({
    leads: [...REQUIRED_LEAD_COLUMNS],
    calls: [...REQUIRED_CALL_COLUMNS],
  });
  assert.ok(present.every((c) => c.ok));
});

test("KB regression fails on leftover EMI-without-math and passes canonical snapshot", () => {
  const stale = evaluateKbRegression([
    {
      title: "EMI without math",
      category: "playbook",
      content: "Kabhi calculate mat karo. [PRECOMPUTED EMI TABLE]",
      source: "sakshi-playbook",
      isActive: true,
      requiresReview: false,
    },
  ]);
  assert.equal(stale.find((c) => c.id === "kb.no_stale_emi_playbook")?.ok, false);
  assert.equal(stale.find((c) => c.id === "kb.live_emi_playbook")?.ok, false);

  const seed = knowledgeSeedRows().map((r) => ({
    title: r.title,
    category: r.category,
    content: r.content,
    source: HERO_CATALOG_SOURCE,
    isActive: true,
    requiresReview: false,
  }));
  const playbooks = PLAYBOOKS.map((p) => ({
    title: p.title,
    category: "playbook",
    content: p.content,
    source: "sakshi-playbook",
    isActive: true,
    requiresReview: false,
  }));
  const clean = evaluateKbRegression([...seed, ...playbooks]);
  const failed = clean.filter((c) => !c.ok);
  assert.deepEqual(failed, [], failed.map((c) => `${c.id}: ${c.detail}`).join("; "));
  assert.ok(LIVE_EMI_PLAYBOOK.content.includes("[EMI:Model|down|months]"));
});

test("app regression requires ₹4/min, live EMI default catalog", () => {
  const bad = evaluateAppRegression({
    costMode: "unknown",
    costBudgetInrPerMin: 2,
    defaultKnowledge: "[PRECOMPUTED EMI TABLE]",
  });
  assert.ok(bad.some((c) => !c.ok));
  const good = evaluateAppRegression({
    costMode: "balanced",
    costBudgetInrPerMin: 4,
    defaultKnowledge: formatDefaultHeroKnowledgeWithLiveEmi(),
  });
  assert.ok(good.every((c) => c.ok), good.filter((c) => !c.ok).map((c) => c.detail).join("; "));
  assert.equal(compileReport(good).ok, true);
});
