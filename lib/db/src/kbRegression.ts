/**
 * Canonical KB / schema regression — pure checks over snapshots.
 * Used by the API health/regress endpoints and unit tests. No DB import.
 */
import { HERO_CATALOG_SOURCE, knowledgeSeedRows, ON_ROAD_JAIPUR } from "./heroCatalog";
import { isStaleEmiPlaybook, LIVE_EMI_PLAYBOOK, PLAYBOOKS } from "./playbooks";

export type KbSnapshotRow = {
  title: string;
  category: string;
  content: string;
  source: string | null;
  isActive: boolean;
  requiresReview: boolean;
};

export type RegressionCheck = {
  id: string;
  area: "app" | "db" | "kb";
  ok: boolean;
  detail: string;
};

export type RegressionReport = {
  ok: boolean;
  checkedAt: string;
  passed: number;
  failed: number;
  checks: RegressionCheck[];
};

export const REQUIRED_LEAD_COLUMNS = [
  "locality",
  "previous_vehicle",
  "exchange_vehicle",
  "objections",
  "promises",
  "csat_score",
  "last_csat_at",
] as const;

export const REQUIRED_CALL_COLUMNS = [
  "greeting_played",
  "avg_turn_ms",
  "barge_in_count",
  "cost_per_min_inr",
] as const;

export function evaluateSchemaRegression(columns: {
  leads: string[];
  calls: string[];
}): RegressionCheck[] {
  const leadSet = new Set(columns.leads);
  const callSet = new Set(columns.calls);
  const checks: RegressionCheck[] = [];
  for (const col of REQUIRED_LEAD_COLUMNS) {
    checks.push({
      id: `db.leads.${col}`,
      area: "db",
      ok: leadSet.has(col),
      detail: leadSet.has(col) ? `leads.${col} present` : `MISSING leads.${col} — run lib/db/sql/ten_on_ten.sql`,
    });
  }
  for (const col of REQUIRED_CALL_COLUMNS) {
    checks.push({
      id: `db.calls.${col}`,
      area: "db",
      ok: callSet.has(col),
      detail: callSet.has(col) ? `calls.${col} present` : `MISSING calls.${col} — run lib/db/sql/ten_on_ten.sql`,
    });
  }
  return checks;
}

export function evaluateKbRegression(rows: KbSnapshotRow[]): RegressionCheck[] {
  const live = rows.filter((r) => r.isActive && !r.requiresReview);
  const checks: RegressionCheck[] = [];

  const stale = live.filter((r) => isStaleEmiPlaybook(r.title, r.content));
  checks.push({
    id: "kb.no_stale_emi_playbook",
    area: "kb",
    ok: stale.length === 0,
    detail: stale.length === 0
      ? "No precomputed / without-math EMI playbook"
      : `Stale EMI cards still live: ${stale.map((r) => r.title).join(", ")}`,
  });

  const liveEmi = live.find((r) => r.category === "playbook" && r.title === LIVE_EMI_PLAYBOOK.title);
  const liveEmiOk = Boolean(liveEmi && liveEmi.content.includes("[EMI:Model|down|months]"));
  checks.push({
    id: "kb.live_emi_playbook",
    area: "kb",
    ok: liveEmiOk,
    detail: liveEmiOk
      ? "Live EMI playbook present with [EMI] tag"
      : "Missing Live EMI playbook — CRM Playbook tab is still the old seed",
  });

  for (const p of PLAYBOOKS) {
    const row = live.find((r) => r.category === "playbook" && r.title === p.title);
    const ok = Boolean(row && row.content.trim() === p.content.trim());
    checks.push({
      id: `kb.playbook.${p.title.replace(/\s+/g, "_").toLowerCase()}`,
      area: "kb",
      ok,
      detail: ok ? `${p.title} matches canonical text` : `${p.title} missing or outdated in knowledge table`,
    });
  }

  const catalog = live.filter((r) => r.source === HERO_CATALOG_SOURCE);
  const seed = knowledgeSeedRows();
  const catalogTitles = new Set(catalog.map((r) => r.title));
  const missingCatalog = seed.filter((s) => !catalogTitles.has(s.title)).map((s) => s.title);
  checks.push({
    id: "kb.hero_catalog_source",
    area: "kb",
    ok: missingCatalog.length === 0 && catalog.length >= seed.length,
    detail: missingCatalog.length === 0
      ? `${catalog.length} hero-catalog rows (source=${HERO_CATALOG_SOURCE})`
      : `Catalog missing: ${missingCatalog.join(", ")}`,
  });

  const priceRow = live.find((r) => r.category === "price" && /on-road/i.test(r.title));
  const glamourOk = Boolean(priceRow?.content.includes("Glamour X DRS=104555"));
  const splendorOk = Boolean(priceRow?.content.includes(`Splendor XTEC=${ON_ROAD_JAIPUR["Splendor XTEC"]}`));
  const superOk = Boolean(priceRow?.content.includes(`Super Splendor XTEC=${ON_ROAD_JAIPUR["Super Splendor XTEC"]}`));
  const plus2 = Boolean(priceRow?.content.includes(`Splendor+ XTEC 2.0=${ON_ROAD_JAIPUR["Splendor+ XTEC 2.0"]}`));
  const distinct = ON_ROAD_JAIPUR["Super Splendor XTEC"] !== ON_ROAD_JAIPUR["Splendor+ XTEC 2.0"];
  checks.push({
    id: "kb.on_road_prices",
    area: "kb",
    ok: glamourOk && splendorOk && superOk && plus2 && distinct,
    detail: glamourOk && splendorOk && superOk && plus2 && distinct
      ? "On-road Jaipur list keeps Super Splendor XTEC distinct from Splendor+ XTEC 2.0"
      : "On-road price list is missing canonical Jaipur figures or mixes Super vs Splendor+",
  });

  const fuel = live.find((r) => r.title === "fuel_price_jaipur");
  const fuelN = Number(fuel?.content?.trim() ?? "");
  checks.push({
    id: "kb.fuel_price",
    area: "kb",
    ok: Number.isFinite(fuelN) && fuelN >= 100 && fuelN <= 120,
    detail: fuel ? `Jaipur petrol ₹${fuel.content.trim()}` : "fuel_price_jaipur missing",
  });

  return checks;
}

export function evaluateAppRegression(input: {
  costMode: string;
  costBudgetInrPerMin: number;
  defaultKnowledge: string;
}): RegressionCheck[] {
  const mode = (input.costMode || "balanced").toLowerCase();
  const budget = Number(input.costBudgetInrPerMin);
  const kb = input.defaultKnowledge;
  return [
    {
      id: "app.cost_mode",
      area: "app",
      ok: mode === "balanced" || mode === "strict",
      detail: `COST_MODE=${mode}`,
    },
    {
      id: "app.cost_budget_inr_per_min",
      area: "app",
      ok: budget === 4,
      detail: budget === 4 ? "₹4/min cap" : `Expected ₹4/min, got ${budget}`,
    },
    {
      id: "app.default_kb_live_emi",
      area: "app",
      ok: /\[LIVE EMI\]/i.test(kb) && !/PRECOMPUTED EMI/i.test(kb),
      detail: /PRECOMPUTED EMI/i.test(kb)
        ? "DEFAULT_HERO_KNOWLEDGE still has a precomputed EMI table"
        : "Default catalog uses live EMI instructions",
    },
    {
      id: "app.default_kb_showroom",
      area: "app",
      ok: /Lal Kothi/i.test(kb) && /Glamour X DRS/i.test(kb),
      detail: /Lal Kothi/i.test(kb) ? "Default catalog has showroom + Glamour X" : "Default catalog missing showroom/models",
    },
    {
      id: "app.super_vs_splendor",
      area: "app",
      ok: /DO NOT MIX — Super Splendor vs Splendor/i.test(kb) && /Super Splendor XTEC/.test(kb) && /Splendor\+ XTEC 2\.0/.test(kb),
      detail: /DO NOT MIX/i.test(kb)
        ? "Default catalog keeps Super Splendor distinct from Splendor+ XTEC 2.0"
        : "Default catalog missing Super vs Splendor mix warning",
    },
  ];
}

export function compileReport(checks: RegressionCheck[]): RegressionReport {
  const failed = checks.filter((c) => !c.ok).length;
  return {
    ok: failed === 0,
    checkedAt: new Date().toISOString(),
    passed: checks.length - failed,
    failed,
    checks,
  };
}
