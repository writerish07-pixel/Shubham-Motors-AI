import { eq, and, sql } from "drizzle-orm";
import { db, callsTable, leadsTable, followupsTable, knowledgeTable } from "@workspace/db";
import {
  analyzeCallIntent,
  getActiveFestivalOffer,
  learnFromTranscript,
  type DiscoverySignals,
} from "./openai";
import { resolveFollowupSchedule } from "./followupSchedule";
import { sendCallSummaryWhatsApp, sendBrochureWhatsApp } from "./whatsapp";
import { logger } from "./logger";

export interface FinalizeCallParams {
  callDbId: number;
  leadId: number;
  transcript: string;
  sessionLanguage: string;
  discoverySignals: DiscoverySignals;
  exotelCallSid?: string;
}

/** Single post-call persistence path for WebSocket voice calls. */
export async function finalizeCompletedCall(params: FinalizeCallParams): Promise<void> {
  const { callDbId, leadId, transcript, sessionLanguage, discoverySignals, exotelCallSid } = params;
  if (!transcript.trim() || !callDbId || !leadId) return;

  const [existingLead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
  if (!existingLead) return;

  const analysis = await analyzeCallIntent(transcript, sessionLanguage);
  const festival = await getActiveFestivalOffer();
  const mergedTimeline =
    analysis.buyingTimeline
    ?? discoverySignals.buyingTimeline
    ?? existingLead.buyingTimeline
    ?? null;

  const callNote = `[Call #${callDbId} - ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}] ${analysis.summary}`;
  const mergedNotes = existingLead.notes?.trim()
    ? `${existingLead.notes.trim()}\n${callNote}`
    : callNote;

  await db
    .update(callsTable)
    .set({
      status: "completed",
      transcript,
      summary: analysis.summary,
      intentDetected: analysis.intent,
      scoreAfterCall: analysis.score,
      languageDetected: analysis.language,
    })
    .where(eq(callsTable.id, callDbId));

  const terminalIntent = analysis.intent === "not_interested" || analysis.intent === "wrong_number";
  const terminalForFollowup = terminalIntent || Boolean(analysis.lostDeal);
  const newStatus = analysis.lostDeal
    ? "lost"
    : terminalIntent
      ? analysis.intent
      : analysis.score >= 80
        ? "hot"
        : analysis.score >= 50
          ? "interested"
          : "contacted";

  await db
    .update(leadsTable)
    .set({
      score: analysis.score,
      status: newStatus,
      language: analysis.language,
      intentSummary: analysis.summary,
      lastCallId: callDbId,
      ...(analysis.preferredModel
        ? { interestedModel: sql`COALESCE(${leadsTable.interestedModel}, ${analysis.preferredModel})` }
        : {}),
      ...(analysis.familyInfo ? { familyInfo: analysis.familyInfo } : {}),
      ...(analysis.competitorMentioned ? { competitorMentioned: analysis.competitorMentioned } : {}),
      ...(analysis.competitorReason ? { competitorReason: analysis.competitorReason } : {}),
      ...(mergedTimeline ? { buyingTimeline: mergedTimeline } : {}),
      notes: mergedNotes,
      ...(discoverySignals.segment ? { segment: discoverySignals.segment } : {}),
      ...(discoverySignals.km ? { dailyKm: discoverySignals.km } : {}),
      ...(discoverySignals.budget ? { budget: discoverySignals.budget } : {}),
      ...(discoverySignals.currentVehicle ? { currentVehicle: discoverySignals.currentVehicle } : {}),
      ...(discoverySignals.purpose === "office" ? { occupation: "office" } : {}),
      ...(analysis.decisionMaker ? { decisionMaker: analysis.decisionMaker } : {}),
      ...(discoverySignals.decisionMaker && !analysis.decisionMaker
        ? { decisionMaker: discoverySignals.decisionMaker }
        : {}),
      ...(analysis.lostDeal && analysis.lostToBrand ? { lostToBrand: analysis.lostToBrand } : {}),
      ...(analysis.lostDeal && analysis.lostToDealer ? { lostToDealer: analysis.lostToDealer } : {}),
      ...(analysis.lostDeal && analysis.lostReason ? { lostReason: analysis.lostReason } : {}),
      ...(analysis.lostDeal && analysis.lostOfferFactor ? { lostOfferFactor: analysis.lostOfferFactor } : {}),
    } as Record<string, unknown>)
    .where(eq(leadsTable.id, leadId));

  if (terminalForFollowup) {
    await db
      .update(followupsTable)
      .set({ status: "cancelled" })
      .where(and(eq(followupsTable.leadId, leadId), eq(followupsTable.status, "pending")));
  } else {
    const followupSchedule = resolveFollowupSchedule({
      intent: analysis.intent,
      score: analysis.score,
      buyingTimeline: mergedTimeline,
      llmFollowupDate: analysis.followupDate,
      llmFollowupReason: analysis.followupReason,
      festivalName: festival?.name ?? null,
    });

    if (followupSchedule) {
      const [existingPending] = await db
        .select({ id: followupsTable.id })
        .from(followupsTable)
        .where(and(eq(followupsTable.leadId, leadId), eq(followupsTable.status, "pending")))
        .limit(1);

      if (!existingPending) {
        await db.insert(followupsTable).values({
          leadId,
          scheduledAt: followupSchedule.date,
          reason: followupSchedule.reason,
          intentLabel: analysis.intent,
          callId: callDbId,
          status: "pending",
          outboundContext: {
            name: existingLead.name,
            interestedModel: analysis.preferredModel ?? existingLead.interestedModel ?? null,
            notes:
              analysis.objections?.length > 0
                ? `Objections: ${analysis.objections.join(", ")}`
                : null,
            lastCallSummary: analysis.summary,
            followupReason: followupSchedule.reason,
          },
        } as any);
      }

      await db
        .update(leadsTable)
        .set({ nextFollowupAt: followupSchedule.date })
        .where(eq(leadsTable.id, leadId));
    }
  }

  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
  if (lead) {
    const sent = await sendCallSummaryWhatsApp(
      lead.phone,
      lead.name,
      analysis.summary,
      lead.interestedModel,
      sessionLanguage,
    ).catch((err) => {
      logger.error({ err }, "WhatsApp summary failed");
      return false;
    });

    if (sent) {
      await db.update(callsTable).set({ whatsappSent: true }).where(eq(callsTable.id, callDbId));
    }

    const modelForBrochure = analysis.preferredModel ?? lead.interestedModel;
    if (modelForBrochure) {
      const [brochure] = await db
        .select()
        .from(knowledgeTable)
        .where(eq(knowledgeTable.category, "brochure"));
      if (brochure?.fileUrl) {
        await sendBrochureWhatsApp(
          lead.phone,
          lead.name,
          modelForBrochure,
          brochure.fileUrl,
          sessionLanguage,
        ).catch((err) => logger.error({ err }, "Brochure WhatsApp failed"));
      }
    }
  }

  await learnFromTranscript(transcript, analysis.summary, exotelCallSid ?? String(callDbId));
}
