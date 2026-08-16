/**
 * Upsert the Hero MotoCorp catalog + Sakshi playbooks into `knowledge`.
 *
 *   DATABASE_URL='postgresql://...' pnpm --filter @workspace/db run seed-hero
 */
import pg from "pg";
import { HERO_CATALOG_SOURCE } from "./heroCatalog.ts";
import { postgresSsl } from "./ssl.ts";
import { syncCanonicalKnowledge } from "./syncKnowledge.ts";

function needsSsl(url: string): boolean {
  const off = process.env.DATABASE_SSL === "0";
  if (off) return false;
  return (
    process.env.NODE_ENV === "production" ||
    /sslmode=require/i.test(url) ||
    /\.rds\.amazonaws\.com/i.test(url)
  );
}

export async function seedHeroKnowledge(): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL must be set");
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: postgresSsl(needsSsl(databaseUrl)),
    max: 2,
  });
  try {
    const result = await syncCanonicalKnowledge(pool);
    return result.catalog;
  } finally {
    await pool.end();
  }
}

seedHeroKnowledge()
  .then((n) => {
    console.log(`Seeded ${n} Hero knowledge rows (source=${HERO_CATALOG_SOURCE})`);
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
