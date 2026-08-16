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
    await seedPlaybooks(pool);
  } finally {
    await pool.end();
  }
  return rows.length;
}

const PLAYBOOK_SOURCE = "sakshi-playbook";

const PLAYBOOKS: Array<{ title: string; content: string }> = [
  {
    title: "Discovery playbook",
    content:
      "Pehle segment (scooter vs bike, CC), roz ka km, family/pillion, budget. Ek sawaal ek baar. Jo mil gaya woh dubara mat poochho. 2 signals ke baad recommend karo.",
  },
  {
    title: "Test-ride close",
    content:
      "Price/EMI ke baad seedha slot: 'Aaj 11 baje test ride kar lein ya shaam 4?' Customer haan kahe toh [VISIT] tag. Address: Lal Kothi, Tonk Road, Jaipur. DL saath laana.",
  },
  {
    title: "Soch ke batata hoon",
    content:
      "Stall hai, interest nahi. Ek blocker poochho (budget / family / compare). Phir ek low-commitment next step: test ride ya WhatsApp price. 'Ji bilkul sochiye' mat bolo.",
  },
  {
    title: "Live EMI",
    content:
      "EMI live reducing-balance se nikalti hai. [EMI:Model|down|months] tag lagao — server hisaab karta hai. Customer ka down payment repeat karo. CIBIL 8.5–12% band batao. Exact lock → [TRANSFER:FINANCE]. Table se mat padho.",
  },
];

async function seedPlaybooks(pool: pg.Pool): Promise<void> {
  const existing = await pool.query("SELECT 1 FROM knowledge WHERE source = $1 LIMIT 1", [PLAYBOOK_SOURCE]);
  if (existing.rowCount && existing.rowCount > 0) return;
  for (const p of PLAYBOOKS) {
    await pool.query(
      `INSERT INTO knowledge (title, category, content, is_active, requires_review, source)
       VALUES ($1, 'playbook', $2, true, false, $3)`,
      [p.title, p.content, PLAYBOOK_SOURCE],
    );
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
