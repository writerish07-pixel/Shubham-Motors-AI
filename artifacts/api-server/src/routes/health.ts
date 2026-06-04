import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { getSttCircuitStatus } from "../lib/sarvam";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  // Include Sarvam STT circuit breaker status so dashboard can show degraded state
  const circuit = getSttCircuitStatus();
  res.json({
    ...data,
    sttCircuit: {
      isOpen: circuit.isOpen,
      failures: circuit.failures,
      lastFailureAt: circuit.lastFailureAt ? new Date(circuit.lastFailureAt).toISOString() : null,
      fallback: circuit.isOpen ? "whisper" : "sarvam",
    },
  });
});

export default router;
