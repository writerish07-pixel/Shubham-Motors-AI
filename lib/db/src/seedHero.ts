/**
 * Upsert the Hero MotoCorp catalog into `knowledge`.
 * Replaces only rows with source = HERO_CATALOG_SOURCE (never wipes offers / review queue).
 *
 *   DATABASE_URL='postgresql://...' pnpm --filter @workspace/db run seed-hero
 */
import fs from "node:fs";
import pg from "pg";
import { HERO_CATALOG_SOURCE, knowledgeSeedRows } from "./heroCatalog.ts";

function ssl(): pg.ConnectionOptions["ssl"] {
  const url = process.env.DATABASE_URL ?? "";
  const off = process.env.DATABASE_SSL === "0";
  if (off) return undefined;
  const needs =
    process.env.NODE_ENV === "production" ||
    /sslmode=require/i.test(url) ||
    /\.rds\.amazonaws\.com/i.test(url);
  if (!needs) return undefined;
  const caPath = process.env.DATABASE_SSL_CA;
  const ca = caPath && fs.existsSync(caPath) ? fs.readFileSync(caPath, "utf8") : undefined;
  return { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
}

export async function seedHeroKnowledge(): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL must be set");
  const rows = knowledgeSeedRows();
  const pool = new pg.Pool({ connectionString: databaseUrl, ssl: ssl(), max: 2 });
  try {
    await pool.query("DELETE FROM knowledge WHERE source = $1", [HERO_CATALOG_SOURCE]);
    for (const r of rows) {
      await pool.query(
        `INSERT INTO knowledge (title, category, content, model_name, is_active, requires_review, source)
         VALUES ($1, $2, $3, $4, true, false, $5)`,
        [r.title, r.category, r.content, r.modelName, HERO_CATALOG_SOURCE],
      );
    }
  } finally {
    await pool.end();
  }
  return rows.length;
}

seedHeroKnowledge()
  .then((n) => {
    console.log(`Seeded ${n} Hero knowledge rows (source=${HERO_CATALOG_SOURCE})`);
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
