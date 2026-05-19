import { Router, type IRouter } from "express";
import {
  getSchedulerStatus,
  runAutoDialer,
  updateSchedulerConfig,
  startScheduler,
  stopScheduler,
} from "../lib/scheduler";

const router: IRouter = Router();

router.get("/scheduler/status", (_req, res): void => {
  res.json(getSchedulerStatus());
});

router.post("/scheduler/run", async (_req, res): Promise<void> => {
  const status = getSchedulerStatus();
  if (status.running) {
    res.status(409).json({ error: "Auto-dialer is already running" });
    return;
  }
  // Fire immediately, return acknowledgement right away
  res.json({ message: "Auto-dialer triggered manually", running: true });
  // Run async so response isn't held
  runAutoDialer().catch(() => {});
});

router.patch("/scheduler/config", (req, res): void => {
  const { cronExpression, maxCallsPerRun, delayBetweenCallsMs, notifyWhatsApp } = req.body;
  const updates: Record<string, unknown> = {};
  if (cronExpression !== undefined) updates.cronExpression = cronExpression;
  if (maxCallsPerRun !== undefined) updates.maxCallsPerRun = Number(maxCallsPerRun);
  if (delayBetweenCallsMs !== undefined) updates.delayBetweenCallsMs = Number(delayBetweenCallsMs);
  if (notifyWhatsApp !== undefined) updates.notifyWhatsApp = Boolean(notifyWhatsApp);
  updateSchedulerConfig(updates as Parameters<typeof updateSchedulerConfig>[0]);
  res.json(getSchedulerStatus());
});

router.post("/scheduler/stop", (_req, res): void => {
  stopScheduler();
  res.json({ message: "Scheduler stopped", status: getSchedulerStatus() });
});

router.post("/scheduler/start", (_req, res): void => {
  startScheduler();
  res.json({ message: "Scheduler started", status: getSchedulerStatus() });
});

export default router;
