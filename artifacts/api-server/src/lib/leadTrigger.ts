/**
 * Speed-to-lead instant call trigger.
 *
 * Research (MIT/InsideSales, dealership BDC data): contacting a lead within
 * 5 minutes makes qualification ~21x more likely vs 30 minutes, and ~78% of
 * buyers purchase from the first dealership to respond. The cron auto-dialer
 * runs every 30 minutes — far too slow for a fresh web/portal enquiry.
 *
 * This module fires on lead creation: it inserts a due follow-up row and
 * immediately runs the auto-dialer, reusing all of its claim/retry/webhook
 * machinery (no duplicate dial logic). Outside the TRAI calling window the
 * follow-up simply waits for the first callable cron slot.
 */

import { and, eq } from "drizzle-orm";
import { db, followupsTable, leadsTable } from "@workspace/db";
import { runAutoDialer } from "./scheduler";
import { logger } from "./logger";

const INSTANT_CALL_SOURCES = new Set([
  "web", "website", "portal", "bikewale", "bikedekho", "missed_call", "whatsapp", "facebook", "instagram", "google",
]);

/** Sources that represent a live customer enquiry (vs bulk import / manual entry). */
export function isInstantCallSource(source: string | null | undefined): boolean {
  if (!source) return false;
  return INSTANT_CALL_SOURCES.has(source.toLowerCase().trim());
}

/**
 * Fire-and-forget: schedule + immediately attempt the first-response call for
 * a brand-new enquiry. Never throws — lead creation must not fail because the
 * dialer hiccuped.
 */
export async function triggerInstantLeadCall(leadId: number): Promise<void> {
  try {
    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
    if (!lead?.phone) return;
    if (lead.doNotCall) {
      logger.info({ leadId }, "Instant call skipped — lead is do-not-call");
      return;
    }

    // Don't stack a second pending follow-up if one already exists.
    const [pending] = await db
      .select({ id: followupsTable.id })
      .from(followupsTable)
      .where(and(eq(followupsTable.leadId, leadId), eq(followupsTable.status, "pending")))
      .limit(1);
    if (pending) return;

    const reason = lead.interestedModel
      ? `नई enquiry — ${lead.interestedModel} में interest dikhaya hai`
      : "नई enquiry — Hero bike/scooter ke baare mein jaankari chahi thi";

    await db.insert(followupsTable).values({
      leadId,
      scheduledAt: new Date(),
      reason,
      intentLabel: "new_enquiry",
      status: "pending",
      outboundContext: {
        name: lead.name,
        interestedModel: lead.interestedModel ?? null,
        notes: lead.notes ?? null,
        lastCallSummary: null,
        followupReason: reason,
      },
    } as any);

    logger.info({ leadId, source: lead.source }, "Speed-to-lead: instant follow-up created — dialing now");

    // Run the dialer right away. isCallableNow() inside it enforces the
    // TRAI window (9:00–20:00 IST, no lunch hour); off-hours enquiries are
    // picked up by the first callable cron run instead.
    void runAutoDialer().catch((err) => logger.error({ err, leadId }, "Instant dial run failed"));
  } catch (err) {
    logger.error({ err, leadId }, "triggerInstantLeadCall failed (lead creation unaffected)");
  }
}
