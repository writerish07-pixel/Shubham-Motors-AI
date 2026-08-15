import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import { postgresSsl } from "./ssl";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

const databaseUrl = process.env.DATABASE_URL;
const sslOff = process.env.DATABASE_SSL === "0";
const needsSsl =
  !sslOff &&
  (process.env.NODE_ENV === "production" ||
    /sslmode=require/i.test(databaseUrl) ||
    /\.rds\.amazonaws\.com/i.test(databaseUrl));

export const pool = new Pool({
  connectionString: databaseUrl,
  ssl: postgresSsl(needsSsl),
  max: 10,
});
export const db = drizzle(pool, { schema });

export * from "./schema";
