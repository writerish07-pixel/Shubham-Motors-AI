import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { HealthCheckResponse } from "@workspace/api-zod";
import { db } from "@workspace/db";
import { getSttCircuitStatus } from "../lib/sarvam";
import { getSchedulerStatus } from "../lib/scheduler";
import { getReplacementMode, whatsappTemplatesOnly } from "../lib/agentTools";

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
    uptimeSec: Math.round(process.uptime()),
    version: process.env.APP_VERSION ?? "dev",
    costMode: process.env.COST_MODE ?? "strict",
    replacementMode: getReplacementMode(),
    whatsappTemplatesOnly: whatsappTemplatesOnly(),
    ncprRequireClear: process.env.NCPR_REQUIRE_CLEAR === "1",
    env: {
      database: Boolean(process.env.DATABASE_URL),
      adminToken: Boolean(process.env.ADMIN_TOKEN),
      sarvam: Boolean(process.env.SARVAM_API_KEY),
      exotel: Boolean(process.env.EXOTEL_SID && process.env.EXOTEL_API_KEY),
      openai: Boolean(process.env.OPENAI_API_KEY ?? process.env.AI_INTEGRATIONS_OPENAI_API_KEY),
      whatsapp: Boolean(process.env.BOTSPACE_API_KEY && process.env.BOTSPACE_PHONE_NUMBER_ID),
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
