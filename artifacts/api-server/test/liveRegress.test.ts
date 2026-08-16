import { test } from "node:test";
import assert from "node:assert/strict";

const LIVE_APP = process.env.REGRESS_BASE_URL ?? "https://shubham-motors-ai.fly.dev";

test("live app healthz: DB up, ₹4/min, balanced cost mode", async () => {
  const res = await fetch(`${LIVE_APP}/api/healthz`);
  assert.equal(res.ok, true, `healthz HTTP ${res.status}`);
  const body = await res.json() as {
    status: string;
    db: string;
    costMode: string;
    costBudgetInrPerMin: number;
    env: { database: boolean; sarvam: boolean; openai: boolean; exotel: boolean };
  };
  assert.equal(body.status, "ok");
  assert.equal(body.db, "connected");
  assert.equal(body.costMode, "balanced");
  assert.equal(body.costBudgetInrPerMin, 4);
  assert.equal(body.env.database, true);
  assert.equal(body.env.sarvam, true);
  assert.equal(body.env.openai, true);
  assert.equal(body.env.exotel, true);
});

test("live /api/regress is all-green when the new endpoint is deployed", async (t) => {
  const res = await fetch(`${LIVE_APP}/api/regress`);
  if (res.status === 401 || res.status === 404) {
    t.skip(`not deployed yet (HTTP ${res.status}) — after merge open ${LIVE_APP}/api/regress`);
    return;
  }
  assert.equal(res.ok, true, `regress HTTP ${res.status}`);
  const body = await res.json() as { ok: boolean; failed: number; checks: Array<{ id: string; ok: boolean; detail: string }> };
  const failed = (body.checks ?? []).filter((c) => !c.ok);
  assert.equal(body.ok, true, failed.map((c) => `${c.id}: ${c.detail}`).join("\n"));
});
