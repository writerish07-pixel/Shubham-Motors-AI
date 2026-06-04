/**
 * scheduler.ts — Auto-dialer with smart follow-up scheduling
 *
 * IMPROVEMENTS vs original (June 2026 audit):
 *   1. Multi-attempt retry: 3 attempts with 30-min gap on no-answer.
 *   2. Context injection: outbound calls carry full leadProfile so Sakshi
 *      opens with "aapne pichli baar Splendor dekhi thi" instead of generic greeting.
 *   3. Smart time windows: groups followups by preferredCallTime (morning/afternoon/evening).
 *      Never calls during lunch (1–2pm) or after 8pm IST.
 *   4. IST timezone explicit — was using server timezone (Replit = UTC).
 *   5. WhatsApp fallback after maxAttempts exhausted.
 *   6. Skip 'not_interested' and 'wrong_number' leads (not just 'lost'/'converted').
 */

import cron from "node-cron";
import { and, eq, lte, or } from "drizzle-orm";
import { db, followupsTable, leadsTable, callsTable } from "@workspace/db";
import { makeOutboundCall } from "./exotel";
import { sendWhatsAppMessage } from "./whatsapp";
import { logger } from "./logger";

// ─── Outbound context map ─────────────────────────────────────────────────────
// Keyed by phone number (10-digit). Set by the scheduler before dialling;
// read by callStream.ts handleStart() to populate session.leadProfile.
// TTL: 5 minutes (enough for Exotel to connect and trigger handleStart).
const _outboundContext = new Map<string, { profile: OutboundLeadContext; expiresAt: number }>();
const CONTEXT_TTL_MS = 5 * 60_000;

// A follow-up sits in 'dialing' between placing the call and receiving the
// Exotel status webhook. If no webhook arrives within this window the call has
// certainly ended, so the due-query re-surfaces the row for retry/fallback.
const STALE_DIALING_MS = 15 * 60_000;

export interface OutboundLeadContext {
  name: string;
  interestedModel?: string | null;
  notes?: string | null;
  lastCallSummary?: string | null;
  followupReason?: string | null;
}

// Normalize phone to last-10 digits so scheduler (raw +91… number) and
// callStream (digits-only) always agree on the map key.
function ctxKey(phone: string): string {
  return phone.replace(/\D/g, "").slice(-10);
}

export function getOutboundContext(phone: string): OutboundLeadContext | null {
  const entry = _outboundContext.get(ctxKey(phone));
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _outboundContext.delete(ctxKey(phone)); return null; }
  return entry.profile;
}

function setOutboundContext(phone: string, ctx: OutboundLeadContext): void {
  _outboundContext.set(ctxKey(phone), { profile: ctx, expiresAt: Date.now() + CONTEXT_TTL_MS });
}

/**
 * Resolve the outcome of an outbound auto-dialer call, called by the Exotel
 * status webhook when a call reaches a terminal state. This is the single
 * owner of outbound follow-up retry policy.
 *
 *   answered === true   → mark the linked follow-up 'completed'
 *   answered === false  → if attempts remain, reschedule 'pending' (+retryDelay);
 *                         otherwise send a WhatsApp fallback and mark it.
 *
 * Finds the follow-up via callId (set to 'dialing' by the scheduler when it
 * placed the call). A no-op if there is no matching 'dialing' follow-up
 * (e.g. an inbound call, or one already resolved / re-dialed).
 */
export async function resolveOutboundFollowupOutcome(
  callId: number,
  answered: boolean,
): Promise<void> {
  const [fu] = await db
    .select()
    .from(followupsTable)
    .where(and(eq(followupsTable.callId, callId), eq(followupsTable.status, "dialing")));

  if (!fu) return;

  const attemptCount = fu.attemptCount ?? 0;
  const maxAttempts = fu.maxAttempts ?? defaultConfig.maxAttemptsPerFollowup;

  // Decide the next state, then claim the row with a single guarded UPDATE
  // (WHERE id AND status='dialing'). Exotel can deliver the same terminal
  // webhook more than once and the scheduler may concurrently re-dial a stale
  // row; the guard ensures exactly one caller wins the transition, so side
  // effects (WhatsApp fallback) fire at most once.
  let nextStatus: string;
  let nextScheduledAt: Date | undefined;
  if (answered) {
    nextStatus = "completed";
  } else if (attemptCount >= maxAttempts) {
    nextStatus = "whatsapp_fallback";
  } else {
    nextStatus = "pending";
    nextScheduledAt = new Date(Date.now() + defaultConfig.retryDelayMinutes * 60_000);
  }

  const claimed = await db.update(followupsTable)
    .set(nextScheduledAt ? { status: nextStatus, scheduledAt: nextScheduledAt } : { status: nextStatus })
    .where(and(eq(followupsTable.id, fu.id), eq(followupsTable.status, "dialing")))
    .returning({ id: followupsTable.id });

  if (claimed.length === 0) return; // a concurrent webhook already resolved it

  if (answered) {
    logger.info({ followupId: fu.id, callId }, "Outbound follow-up answered — marked completed");
  } else if (nextStatus === "whatsapp_fallback") {
    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, fu.leadId));
    if (lead?.phone) {
      const msg = `नमस्ते ${lead.name || ""} जी! 🙏 हमने कई बार call करने की कोशिश की लेकिन connect नहीं हो सका। अगर आप Hero bike या scooter के बारे में जानकारी चाहते हैं, तो हमें इस नंबर पर WhatsApp या call करें। — Shubham Motors, Jaipur 🏍️`;
      await sendWhatsAppMessage(lead.phone, msg).catch(() => {});
    }
    logger.info({ followupId: fu.id, callId, attemptCount }, "Outbound follow-up exhausted retries — WhatsApp fallback");
  } else {
    logger.info(
      { followupId: fu.id, callId, attempt: attemptCount, retryAt: nextScheduledAt?.toISOString() },
      "Outbound follow-up not answered — rescheduled for retry",
    );
  }
}

// ─── IST helpers ──────────────────────────────────────────────────────────────
// Replit servers run UTC. All scheduling must be done in IST (UTC+5:30).
function nowIST(): Date {
  return new Date(new Date().getTime() + 5.5 * 3600_000);
}

function hourIST(): number {
  return nowIST().getHours();
}

// Returns true if current IST time is in a "callable" window.
function isCallableNow(preferredTime?: string | null): boolean {
  const h = hourIST();
  // Never call during lunch (13:00–14:00) or after 20:00 or before 09:00
  if (h < 9 || h >= 20 || (h === 13)) return false;

  if (!preferredTime) return true; // no preference — any business hour is fine

  if (preferredTime === "morning" && h >= 9 && h < 12) return true;
  if (preferredTime === "afternoon" && h >= 14 && h < 17) return true;
  if (preferredTime === "evening" && h >= 17 && h < 20) return true;

  // Outside preferred window — only call if it's already late afternoon and this
  // is a retry (don't wait forever). Allow 17:00+ for morning-preferred leads on retry.
  if (h >= 17) return true;

  return false;
}

// ─── Types ────────────────────────────────────────────────────────────────────

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
  whatsappFallback: number;
  details: Array<{
    followupId: number;
    leadName: string;
    phone: string;
    success: boolean;
    reason: string;
  }>;
}

export interface SchedulerConfig {
  cronExpression: string;
  maxCallsPerRun: number;
  delayBetweenCallsMs: number;
  callbackBaseUrl: string;
  notifyWhatsApp: boolean;
  maxAttemptsPerFollowup: number;
  retryDelayMinutes: number;
}

const defaultConfig: SchedulerConfig = {
  // Run every 30 minutes during business hours IST (9am–8pm)
  // Cron in server time (UTC): 9am IST = 3:30am UTC, 8pm IST = 2:30pm UTC
  // Simplified: run every 30 min and let isCallableNow() gate individual calls
  cronExpression: "*/30 * * * *",
  maxCallsPerRun: 50,
  delayBetweenCallsMs: 5000,
  callbackBaseUrl: process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : "http://localhost:5000",
  notifyWhatsApp: true,
  maxAttemptsPerFollowup: 3,   // NEW: retry up to 3 times
  retryDelayMinutes: 30,       // NEW: 30 min between retries
};

let schedulerStatus: SchedulerStatus = {
  running: false,
  lastRun: null,
  lastRunResult: null,
  nextRun: computeNextRun(defaultConfig.cronExpression),
  config: { ...defaultConfig },
};

let cronTask: ReturnType<typeof cron.schedule> | null = null;
let manualRunInProgress = false;

function computeNextRun(expr: string): string {
  const now = new Date();
  const next = new Date(now.getTime() + 30 * 60_000);
  return next.toISOString();
}

// ─── Blocked statuses (won't get a follow-up call) ───────────────────────────
const SKIP_STATUSES = new Set(["lost", "converted", "not_interested", "wrong_number"]);

// ─── Main auto-dialer ─────────────────────────────────────────────────────────
export async function runAutoDialer(): Promise<RunResult> {
  if (manualRunInProgress) {
    logger.warn("Auto-dialer already running, skipping");
    return { attempted: 0, succeeded: 0, failed: 0, skipped: 1, whatsappFallback: 0, details: [] };
  }

  manualRunInProgress = true;
  schedulerStatus.running = true;
  const startTime = new Date().toISOString();
  logger.info({ istHour: hourIST() }, "Auto-dialer started");

  const result: RunResult = {
    attempted: 0, succeeded: 0, failed: 0, skipped: 0, whatsappFallback: 0, details: [],
  };

  try {
    const now = new Date();
    const dueFollowups = await db
      .select({
        followupId: followupsTable.id,
        leadId: followupsTable.leadId,
        reason: followupsTable.reason,
        scheduledAt: followupsTable.scheduledAt,
        // NEW: retry tracking fields (will be null if columns not yet migrated — handled below)
        attemptCount: (followupsTable as any).attemptCount,
        maxAttempts: (followupsTable as any).maxAttempts,
        lastAttemptAt: (followupsTable as any).lastAttemptAt,
        outboundContext: (followupsTable as any).outboundContext,
        status: followupsTable.status,
        leadName: leadsTable.name,
        leadPhone: leadsTable.phone,
        leadStatus: leadsTable.status,
        leadInterestedModel: leadsTable.interestedModel,
        leadNotes: leadsTable.notes,
        leadIntentSummary: leadsTable.intentSummary,
        preferredCallTime: (leadsTable as any).preferredCallTime,
      })
      .from(followupsTable)
      .leftJoin(leadsTable, eq(followupsTable.leadId, leadsTable.id))
      .where(
        or(
          // Normal due follow-ups
          and(
            eq(followupsTable.status, "pending"),
            lte(followupsTable.scheduledAt, now),
          ),
          // Recovery: a 'dialing' row whose status webhook never arrived.
          // After STALE_DIALING_MS the call has certainly terminated, so we
          // re-surface it and let the attempt/retry logic dial again or fall back.
          and(
            eq(followupsTable.status, "dialing"),
            lte((followupsTable as any).lastAttemptAt, new Date(now.getTime() - STALE_DIALING_MS)),
          ),
        )
      )
      .limit(schedulerStatus.config.maxCallsPerRun);

    logger.info({ count: dueFollowups.length }, "Due follow-ups found");

    for (const followup of dueFollowups) {
      // Skip if no phone number
      if (!followup.leadPhone || !followup.leadName) {
        result.skipped++;
        result.details.push({ followupId: followup.followupId, leadName: followup.leadName ?? `Lead #${followup.leadId}`, phone: followup.leadPhone ?? "unknown", success: false, reason: "Missing phone number" });
        await db.update(followupsTable).set({ status: "failed" }).where(eq(followupsTable.id, followup.followupId));
        continue;
      }

      // NEW: Skip 'not_interested' and 'wrong_number' in addition to 'lost'/'converted'
      if (followup.leadStatus && SKIP_STATUSES.has(followup.leadStatus)) {
        result.skipped++;
        result.details.push({ followupId: followup.followupId, leadName: followup.leadName, phone: followup.leadPhone, success: false, reason: `Lead status is ${followup.leadStatus}, skipping` });
        await db.update(followupsTable).set({ status: "cancelled" }).where(eq(followupsTable.id, followup.followupId));
        continue;
      }

      // NEW: Check callable time window
      const preferred = followup.preferredCallTime as string | null;
      if (!isCallableNow(preferred)) {
        // Don't skip — just defer to next cron run naturally (don't reschedule, scheduledAt is already past)
        result.skipped++;
        result.details.push({ followupId: followup.followupId, leadName: followup.leadName, phone: followup.leadPhone, success: false, reason: `Outside callable window (IST hour: ${hourIST()}, preference: ${preferred ?? "any"})` });
        continue;
      }

      // NEW: Check retry limit
      const attemptCount = (followup.attemptCount as number | null) ?? 0;
      const maxAttempts = (followup.maxAttempts as number | null) ?? schedulerStatus.config.maxAttemptsPerFollowup;
      if (attemptCount >= maxAttempts) {
        // All retries exhausted — send WhatsApp fallback
        result.whatsappFallback++;
        const msg = `नमस्ते ${followup.leadName} जी! 🙏 हमने कई बार call करने की कोशिश की लेकिन connect नहीं हो सका। अगर आप Hero bike या scooter के बारे में जानकारी चाहते हैं, तो हमें इस नंबर पर WhatsApp या call करें। — Shubham Motors, Jaipur 🏍️`;
        await sendWhatsAppMessage(followup.leadPhone, msg).catch(() => {});
        await db.update(followupsTable).set({ status: "whatsapp_fallback" }).where(eq(followupsTable.id, followup.followupId));
        result.details.push({ followupId: followup.followupId, leadName: followup.leadName, phone: followup.leadPhone, success: true, reason: "Max retries — WhatsApp fallback sent" });
        continue;
      }

      // Atomically claim this follow-up before dialing. A concurrent status
      // webhook only ever moves a row OFF 'dialing', so guarding on the exact
      // status we selected guarantees we never redial a row that was just
      // resolved (prevents duplicate calls during stale-'dialing' recovery).
      // The claim also records this attempt (status/attemptCount/lastAttemptAt),
      // so the success/failure branches below must NOT increment again.
      const claimed = await db.update(followupsTable)
        .set({
          status: "dialing",
          attemptCount: attemptCount + 1,
          lastAttemptAt: new Date(),
        })
        .where(and(
          eq(followupsTable.id, followup.followupId),
          eq(followupsTable.status, followup.status),
        ))
        .returning({ id: followupsTable.id });

      if (claimed.length === 0) {
        result.skipped++;
        result.details.push({ followupId: followup.followupId, leadName: followup.leadName, phone: followup.leadPhone, success: false, reason: "Resolved by status webhook before dial — skipped" });
        continue;
      }

      result.attempted++;

      try {
        const callbackUrl = schedulerStatus.config.callbackBaseUrl;

        // NEW: Inject outbound context so Sakshi opens with personalization
        const ctx: OutboundLeadContext = {
          name: followup.leadName,
          interestedModel: followup.leadInterestedModel ?? null,
          notes: followup.leadNotes ?? null,
          lastCallSummary: followup.leadIntentSummary ?? null,
          followupReason: followup.reason ?? null,
        };
        setOutboundContext(followup.leadPhone, ctx);

        const callSid = await makeOutboundCall(followup.leadPhone, callbackUrl);

        if (callSid) {
          const [newCall] = await db.insert(callsTable).values({
            leadId: followup.leadId,
            direction: "outbound",
            status: "initiated",
            exotelCallSid: callSid,
          }).returning();

          // Initiation succeeded — the call is now ringing. The claim above
          // already set status='dialing' and recorded the attempt; here we only
          // link the call so the Exotel status webhook can resolve the outcome:
          //   answered            → resolveOutboundFollowupOutcome marks 'completed'
          //   no-answer/busy/fail → retry (reschedule 'pending') or WhatsApp fallback
          // A 'dialing' row is skipped by the due-query until the webhook resolves
          // it, or until it goes stale (webhook never arrived) and is recovered.
          await db.update(followupsTable)
            .set({ callId: newCall.id })
            .where(eq(followupsTable.id, followup.followupId));

          if (schedulerStatus.config.notifyWhatsApp) {
            const model = followup.leadInterestedModel ? ` (${followup.leadInterestedModel})` : "";
            const msg = `नमस्ते ${followup.leadName} जी! 🏍️ हम आपको Hero bike${model} के बारे में call कर रहे हैं। अगर हम miss हो जाएं, तो please call back करें। — Shubham Motors, Jaipur`;
            await sendWhatsAppMessage(followup.leadPhone, msg).catch(() => {
              logger.warn({ phone: followup.leadPhone }, "WhatsApp notify failed, continuing");
            });
          }

          result.succeeded++;
          result.details.push({ followupId: followup.followupId, leadName: followup.leadName, phone: followup.leadPhone, success: true, reason: `Call initiated (SID: ${callSid}), attempt ${attemptCount + 1}/${maxAttempts}` });
          logger.info({ leadName: followup.leadName, callSid, attempt: attemptCount + 1 }, "Auto-dialer call initiated");
        } else {
          throw new Error("No CallSid returned from Exotel");
        }
      } catch (err) {
        result.failed++;
        const errMsg = err instanceof Error ? err.message : String(err);

        // Initiation failed — the claim already incremented attemptCount and set
        // status='dialing', so reset the row to 'pending' and reschedule. Once
        // attemptCount reaches maxAttempts, the retry-limit check at the top of
        // the next run sends the WhatsApp fallback instead of dialing again.
        const nextAttempt = new Date(Date.now() + schedulerStatus.config.retryDelayMinutes * 60_000);
        await db.update(followupsTable)
          .set({
            status: "pending",
            scheduledAt: nextAttempt,
          })
          .where(eq(followupsTable.id, followup.followupId));

        result.details.push({ followupId: followup.followupId, leadName: followup.leadName, phone: followup.leadPhone, success: false, reason: `${errMsg} — rescheduled for ${nextAttempt.toISOString()}` });
        logger.warn({ err, leadName: followup.leadName, attempt: attemptCount + 1 }, "Auto-dialer call failed — rescheduled");
      }

      if (schedulerStatus.config.delayBetweenCallsMs > 0) {
        await new Promise((r) => setTimeout(r, schedulerStatus.config.delayBetweenCallsMs));
      }
    }

    logger.info(
      { attempted: result.attempted, succeeded: result.succeeded, failed: result.failed, skipped: result.skipped },
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

// ─── Scheduler control ────────────────────────────────────────────────────────

export function getSchedulerStatus(): SchedulerStatus {
  return { ...schedulerStatus };
}

export function updateSchedulerConfig(updates: Partial<SchedulerConfig>): void {
  schedulerStatus.config = { ...schedulerStatus.config, ...updates };
  if (updates.cronExpression) {
    schedulerStatus.nextRun = computeNextRun(updates.cronExpression);
    if (cronTask) { cronTask.stop(); cronTask = null; }
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
    logger.info({ expr, istHour: hourIST() }, "Cron triggered — running auto-dialer");
    await runAutoDialer();
  });
  schedulerStatus.nextRun = computeNextRun(expr);
  logger.info({ expr, nextRun: schedulerStatus.nextRun }, "Auto-dialer scheduler started");
}

export function stopScheduler(): void {
  if (cronTask) { cronTask.stop(); cronTask = null; logger.info("Auto-dialer scheduler stopped"); }
}
