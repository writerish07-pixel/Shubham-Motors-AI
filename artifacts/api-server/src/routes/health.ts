import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { HealthCheckResponse } from "@workspace/api-zod";
import { db } from "@workspace/db";
import { getSttCircuitStatus } from "../lib/sarvam";
import { getSchedulerStatus } from "../lib/scheduler";

const router: IRouter = Router();

router.get("/healthz", async (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  const circuit = getSttCircuitStatus();

  let dbOk = false;
  try {
    await db.execute(sql`SELECT 1`);
    dbOk = true;
  } catch {
    dbOk = false;
  }

  const envOk = Boolean(
    process.env.DATABASE_URL &&
    process.env.ADMIN_TOKEN &&
    process.env.SARVAM_API_KEY,
  );

  res.json({
    ...data,
    status: dbOk && envOk ? "ok" : "degraded",
    db: dbOk ? "connected" : "error",
    env: {
      database: Boolean(process.env.DATABASE_URL),
      adminToken: Boolean(process.env.ADMIN_TOKEN),
      sarvam: Boolean(process.env.SARVAM_API_KEY),
      exotel: Boolean(process.env.EXOTEL_SID && process.env.EXOTEL_API_KEY),
    },
    scheduler: getSchedulerStatus().running,
    sttCircuit: {
      isOpen: circuit.isOpen,
      failures: circuit.failures,
      lastFailureAt: circuit.lastFailureAt ? new Date(circuit.lastFailureAt).toISOString() : null,
      fallback: circuit.isOpen ? "whisper" : "sarvam",
    },
  });
});

export default router;
