import { pool } from "@workspace/db";
import { formatDefaultHeroKnowledgeWithLiveEmi } from "@workspace/db/heroCatalog";
import {
  compileReport,
  evaluateAppRegression,
  type RegressionReport,
} from "@workspace/db/kbRegression";
import { runKbDbRegression, syncCanonicalKnowledge } from "@workspace/db/syncKnowledge";
import { computeEmi } from "./emiQuote";
import { logger } from "./logger";

let inflight: Promise<{ catalog: number; playbooks: number; staleRewritten: number }> | null = null;

/** One shared boot/CRM/agent sync so leftover seed cards cannot survive a deploy. */
export function syncCanonicalKnowledgeOnce(): Promise<{ catalog: number; playbooks: number; staleRewritten: number }> {
  if (!inflight) {
    inflight = syncCanonicalKnowledge(pool)
      .then(async (result) => {
        const { invalidateKnowledgeCache } = await import("./openai");
        invalidateKnowledgeCache();
        logger.info(result, "Canonical knowledge synced");
        return result;
      })
      .catch((err) => {
        inflight = null;
        logger.warn({ err }, "canonical knowledge sync failed");
        return { catalog: 0, playbooks: 0, staleRewritten: 0 };
      });
  }
  return inflight;
}

export async function buildRegressionReport(): Promise<RegressionReport> {
  await syncCanonicalKnowledgeOnce();
  const dbReport = await runKbDbRegression(pool);
  const appChecks = evaluateAppRegression({
    costMode: process.env.COST_MODE ?? "balanced",
    costBudgetInrPerMin: Number(process.env.COST_ALERT_INR_PER_MIN ?? 4),
    defaultKnowledge: formatDefaultHeroKnowledgeWithLiveEmi(),
  });
  const sampleEmi = computeEmi(100000, 24, 0.09);
  const emiCheck = {
    id: "app.live_emi_formula",
    area: "app" as const,
    ok: sampleEmi > 4500 && sampleEmi < 4700,
    detail: `computeEmi(₹1,00,000 / 24mo / 9%) = ₹${sampleEmi.toLocaleString("en-IN")}`,
  };
  return compileReport([...appChecks, emiCheck, ...dbReport.checks]);
}
