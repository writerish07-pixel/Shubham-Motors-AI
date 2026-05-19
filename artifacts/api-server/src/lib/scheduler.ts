import cron from "node-cron";
import { and, eq, lte } from "drizzle-orm";
import { db, followupsTable, leadsTable, callsTable } from "@workspace/db";
import { makeOutboundCall } from "./exotel";
import { sendWhatsAppMessage } from "./whatsapp";
import { logger } from "./logger";

export interface SchedulerStatus {
  running: boolean;
  lastRun: string | null;
  lastRunResult: RunResult | null;
  nextRun: string;
  config: SchedulerConfig;
}

export interface RunResult {
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
  details: Array<{ followupId: number; leadName: string; phone: string; success: boolean; reason: string }>;
}

export interface SchedulerConfig {
  cronExpression: string;
  maxCallsPerRun: number;
  delayBetweenCallsMs: number;
  callbackBaseUrl: string;
  notifyWhatsApp: boolean;
}

const defaultConfig: SchedulerConfig = {
  cronExpression: "0 9 * * *",      // 9:00 AM every day
  maxCallsPerRun: 50,
  delayBetweenCallsMs: 5000,        // 5 seconds between calls
  callbackBaseUrl: process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : "http://localhost:5000",
  notifyWhatsApp: true,
};

let schedulerStatus: SchedulerStatus = {
  running: false,
  lastRun: null,
  lastRunResult: null,
  nextRun: computeNextRun(defaultConfig.cronExpression),
  config: { ...defaultConfig },
};

let cronTask: cron.ScheduledTask | null = null;
let manualRunInProgress = false;

function computeNextRun(expr: string): string {
  // Simple next-run estimation from cron expression
  // For 9 AM daily: find next 9 AM
  const now = new Date();
  const next = new Date(now);
  next.setSeconds(0);
  next.setMilliseconds(0);

  try {
    const parts = expr.trim().split(/\s+/);
    if (parts.length === 5) {
      const [min, hour] = parts;
      next.setMinutes(parseInt(min) || 0);
      next.setHours(parseInt(hour) || 9);
      if (next <= now) next.setDate(next.getDate() + 1);
    }
  } catch {
    next.setDate(next.getDate() + 1);
    next.setHours(9, 0, 0, 0);
  }

  return next.toISOString();
}

export async function runAutoDialer(): Promise<RunResult> {
  if (manualRunInProgress) {
    logger.warn("Auto-dialer already running, skipping");
    return { attempted: 0, succeeded: 0, failed: 0, skipped: 1, details: [] };
  }

  manualRunInProgress = true;
  schedulerStatus.running = true;
  const startTime = new Date().toISOString();
  logger.info("Auto-dialer started");

  const result: RunResult = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    details: [],
  };

  try {
    // Fetch all pending follow-ups that are due (scheduledAt <= now)
    const now = new Date();
    const dueFollowups = await db
      .select({
        followupId: followupsTable.id,
        leadId: followupsTable.leadId,
        reason: followupsTable.reason,
        scheduledAt: followupsTable.scheduledAt,
        leadName: leadsTable.name,
        leadPhone: leadsTable.phone,
        leadStatus: leadsTable.status,
      })
      .from(followupsTable)
      .leftJoin(leadsTable, eq(followupsTable.leadId, leadsTable.id))
      .where(
        and(
          eq(followupsTable.status, "pending"),
          lte(followupsTable.scheduledAt, now)
        )
      )
      .limit(schedulerStatus.config.maxCallsPerRun);

    logger.info({ count: dueFollowups.length }, "Due follow-ups found");

    if (dueFollowups.length === 0) {
      schedulerStatus.running = false;
      schedulerStatus.lastRun = startTime;
      schedulerStatus.lastRunResult = result;
      schedulerStatus.nextRun = computeNextRun(schedulerStatus.config.cronExpression);
      manualRunInProgress = false;
      return result;
    }

    const callbackUrl = `${schedulerStatus.config.callbackBaseUrl}/api/webhooks/exotel/inbound`;

    for (const followup of dueFollowups) {
      if (!followup.leadPhone || !followup.leadName) {
        result.skipped++;
        result.details.push({
          followupId: followup.followupId,
          leadName: followup.leadName ?? `Lead #${followup.leadId}`,
          phone: followup.leadPhone ?? "unknown",
          success: false,
          reason: "Missing phone number",
        });
        // Mark as failed in DB
        await db.update(followupsTable)
          .set({ status: "failed" })
          .where(eq(followupsTable.id, followup.followupId));
        continue;
      }

      // Skip lost leads
      if (followup.leadStatus === "lost" || followup.leadStatus === "converted") {
        result.skipped++;
        result.details.push({
          followupId: followup.followupId,
          leadName: followup.leadName,
          phone: followup.leadPhone,
          success: false,
          reason: `Lead status is ${followup.leadStatus}, skipping`,
        });
        await db.update(followupsTable)
          .set({ status: "cancelled" })
          .where(eq(followupsTable.id, followup.followupId));
        continue;
      }

      result.attempted++;

      try {
        const callSid = await makeOutboundCall(followup.leadPhone, callbackUrl);

        if (callSid) {
          // Log the call
          await db.insert(callsTable).values({
            leadId: followup.leadId,
            direction: "outbound",
            status: "initiated",
            exotelCallSid: callSid,
          });

          // Mark follow-up as completed
          await db.update(followupsTable)
            .set({ status: "completed" })
            .where(eq(followupsTable.id, followup.followupId));

          // Send WhatsApp reminder if enabled
          if (schedulerStatus.config.notifyWhatsApp) {
            const msg = `Hello ${followup.leadName}! 📞 We're calling you back as scheduled regarding your Hero bike inquiry. If we miss you, we'll try again soon! — Shubham Motors 🏍️`;
            await sendWhatsAppMessage(followup.leadPhone, msg).catch(() => {
              logger.warn({ phone: followup.leadPhone }, "WhatsApp notify failed, continuing");
            });
          }

          result.succeeded++;
          result.details.push({
            followupId: followup.followupId,
            leadName: followup.leadName,
            phone: followup.leadPhone,
            success: true,
            reason: `Call initiated (SID: ${callSid})`,
          });

          logger.info({ leadName: followup.leadName, callSid }, "Auto-dialer call initiated");
        } else {
          throw new Error("No CallSid returned from Exotel");
        }
      } catch (err) {
        result.failed++;
        const errMsg = err instanceof Error ? err.message : String(err);
        result.details.push({
          followupId: followup.followupId,
          leadName: followup.leadName,
          phone: followup.leadPhone,
          success: false,
          reason: errMsg,
        });

        // Mark follow-up as failed
        await db.update(followupsTable)
          .set({ status: "failed" })
          .where(eq(followupsTable.id, followup.followupId));

        logger.error({ err, leadName: followup.leadName }, "Auto-dialer call failed");
      }

      // Delay between calls to avoid overwhelming Exotel
      if (schedulerStatus.config.delayBetweenCallsMs > 0) {
        await new Promise((r) => setTimeout(r, schedulerStatus.config.delayBetweenCallsMs));
      }
    }

    logger.info(
      { attempted: result.attempted, succeeded: result.succeeded, failed: result.failed },
      "Auto-dialer run complete"
    );
  } catch (err) {
    logger.error({ err }, "Auto-dialer run error");
  } finally {
    schedulerStatus.running = false;
    schedulerStatus.lastRun = startTime;
    schedulerStatus.lastRunResult = result;
    schedulerStatus.nextRun = computeNextRun(schedulerStatus.config.cronExpression);
    manualRunInProgress = false;
  }

  return result;
}

export function getSchedulerStatus(): SchedulerStatus {
  return { ...schedulerStatus };
}

export function updateSchedulerConfig(updates: Partial<SchedulerConfig>): void {
  schedulerStatus.config = { ...schedulerStatus.config, ...updates };

  if (updates.cronExpression) {
    schedulerStatus.nextRun = computeNextRun(updates.cronExpression);
    // Restart cron with new expression
    if (cronTask) {
      cronTask.stop();
      cronTask = null;
    }
    startScheduler();
  }
}

export function startScheduler(): void {
  if (cronTask) return;

  const expr = schedulerStatus.config.cronExpression;

  if (!cron.validate(expr)) {
    logger.error({ expr }, "Invalid cron expression, scheduler not started");
    return;
  }

  cronTask = cron.schedule(expr, async () => {
    logger.info({ expr }, "Cron triggered — running auto-dialer");
    await runAutoDialer();
  });

  schedulerStatus.nextRun = computeNextRun(expr);
  logger.info({ expr, nextRun: schedulerStatus.nextRun }, "Auto-dialer scheduler started");
}

export function stopScheduler(): void {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
    logger.info("Auto-dialer scheduler stopped");
  }
}
