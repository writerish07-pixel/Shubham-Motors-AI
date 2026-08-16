/**
 * Idempotent canonical KB + schema sync. Safe to run on every API boot.
 * Does not wipe dealer uploads (offers/stock/review queue).
 */
import type pg from "pg";
import { HERO_CATALOG_SOURCE, knowledgeSeedRows } from "./heroCatalog";
import {
  DEDUPE_LIVE_EMI_SQL,
  LIVE_EMI_PLAYBOOK,
  PLAYBOOK_SOURCE,
  PLAYBOOKS,
  REWRITE_STALE_EMI_SQL,
} from "./playbooks";
import {
  compileReport,
  evaluateKbRegression,
  evaluateSchemaRegression,
  type KbSnapshotRow,
  type RegressionReport,
} from "./kbRegression";

const SCHEMA_SQL = [
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS locality text`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS previous_vehicle text`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS exchange_vehicle text`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS objections text`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS promises text`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS csat_score integer`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_csat_at timestamptz`,
  `ALTER TABLE calls ADD COLUMN IF NOT EXISTS greeting_played boolean`,
  `ALTER TABLE calls ADD COLUMN IF NOT EXISTS avg_turn_ms integer`,
  `ALTER TABLE calls ADD COLUMN IF NOT EXISTS barge_in_count integer`,
  `ALTER TABLE calls ADD COLUMN IF NOT EXISTS cost_per_min_inr integer`,
];

export async function ensureTenOnTenSchema(pool: pg.Pool): Promise<void> {
  for (const stmt of SCHEMA_SQL) {
    await pool.query(stmt);
  }
}

export async function syncPlaybooks(pool: pg.Pool): Promise<{ rewritten: number; upserted: number }> {
  const rewritten = await pool.query(REWRITE_STALE_EMI_SQL, [
    LIVE_EMI_PLAYBOOK.title,
    LIVE_EMI_PLAYBOOK.content,
    PLAYBOOK_SOURCE,
  ]);
  await pool.query(DEDUPE_LIVE_EMI_SQL, [LIVE_EMI_PLAYBOOK.title]);

  let upserted = 0;
  for (const p of PLAYBOOKS) {
    const existing = await pool.query(
      `SELECT id FROM knowledge WHERE category = 'playbook' AND title = $1 ORDER BY id ASC LIMIT 1`,
      [p.title],
    );
    if (existing.rowCount && existing.rowCount > 0) {
      await pool.query(
        `UPDATE knowledge
         SET content = $1, is_active = true, requires_review = false, source = $2, updated_at = NOW()
         WHERE id = $3`,
        [p.content, PLAYBOOK_SOURCE, existing.rows[0]!.id],
      );
    } else {
      await pool.query(
        `INSERT INTO knowledge (title, category, content, is_active, requires_review, source)
         VALUES ($1, 'playbook', $2, true, false, $3)`,
        [p.title, p.content, PLAYBOOK_SOURCE],
      );
    }
    upserted += 1;
  }
  return { rewritten: rewritten.rowCount ?? 0, upserted };
}

export async function syncHeroCatalog(pool: pg.Pool): Promise<number> {
  const rows = knowledgeSeedRows();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM knowledge WHERE source = $1", [HERO_CATALOG_SOURCE]);
    for (const r of rows) {
      await client.query(
        `INSERT INTO knowledge (title, category, content, model_name, is_active, requires_review, source)
         VALUES ($1, $2, $3, $4, true, false, $5)`,
        [r.title, r.category, r.content, r.modelName, HERO_CATALOG_SOURCE],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return rows.length;
}

export async function syncCanonicalKnowledge(pool: pg.Pool): Promise<{
  catalog: number;
  playbooks: number;
  staleRewritten: number;
}> {
  await ensureTenOnTenSchema(pool);
  const catalog = await syncHeroCatalog(pool);
  const pb = await syncPlaybooks(pool);
  return { catalog, playbooks: pb.upserted, staleRewritten: pb.rewritten };
}

export async function loadKbSnapshot(pool: pg.Pool): Promise<KbSnapshotRow[]> {
  const res = await pool.query(
    `SELECT title, category, content, source, is_active AS "isActive", requires_review AS "requiresReview"
     FROM knowledge`,
  );
  return res.rows as KbSnapshotRow[];
}

export async function loadSchemaColumns(pool: pg.Pool): Promise<{ leads: string[]; calls: string[] }> {
  const res = await pool.query(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name IN ('leads', 'calls')`,
  );
  const leads: string[] = [];
  const calls: string[] = [];
  for (const row of res.rows as Array<{ table_name: string; column_name: string }>) {
    if (row.table_name === "leads") leads.push(row.column_name);
    if (row.table_name === "calls") calls.push(row.column_name);
  }
  return { leads, calls };
}

export async function runKbDbRegression(pool: pg.Pool): Promise<RegressionReport> {
  const [rows, columns] = await Promise.all([loadKbSnapshot(pool), loadSchemaColumns(pool)]);
  return compileReport([
    ...evaluateSchemaRegression(columns),
    ...evaluateKbRegression(rows),
  ]);
}
