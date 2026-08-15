import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTurn, costMode } from "../src/lib/modelRouter";

test("COST_MODE=strict (default): never promotes to gpt-4o", () => {
  const prev = process.env.COST_MODE;
  delete process.env.COST_MODE;
  try {
    assert.equal(costMode(), "strict");
    assert.equal(classifyTurn("Honda se compare karo EMI kam karo", []), "mini");
  } finally {
    if (prev === undefined) delete process.env.COST_MODE;
    else process.env.COST_MODE = prev;
  }
});

test("COST_MODE=balanced: competitor/price turns use premium", () => {
  const prev = process.env.COST_MODE;
  process.env.COST_MODE = "balanced";
  try {
    assert.equal(classifyTurn("Honda se compare karo", []), "premium");
    assert.equal(classifyTurn("hello", []), "mini");
  } finally {
    if (prev === undefined) delete process.env.COST_MODE;
    else process.env.COST_MODE = prev;
  }
});
