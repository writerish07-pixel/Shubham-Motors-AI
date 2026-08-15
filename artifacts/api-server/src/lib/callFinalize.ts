import { eq, and, sql, count } from "drizzle-orm";
import { db, callsTable, leadsTable, followupsTable, knowledgeTable, shadowScoresTable } from "@workspace/db";
import {
  analyzeCallIntent,
  getActiveFestivalOffer,
  learnFromTranscript,
  type DiscoverySignals,
} from "./openai";
import { resolveFollowupSchedule, parseLlmFollowupDate } from "./followupSchedule";
import { sendCallSummaryWhatsApp, sendBrochureWhatsApp } from "./whatsapp";
import { resolveModelOnRoad, computeEmi } from "./emiQuote";
import { computeLeadIntelligence } from "./relationshipIntel";
import { logger } from "./logger";
import { scoreCallShadow } from "./agentTools";

type CallAnalysis = Awaited<ReturnType<typeof analyzeCallIntent>>;

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

  // Analysis must never block the post-call WhatsApp — if the LLM call fails,
  // fall back to a neutral analysis so the customer still gets summary + price.
  let analysis: CallAnalysis;
  try {
    analysis = await analyzeCallIntent(transcript, sessionLanguage);
  } catch (err) {
    logger.error({ err, callDbId }, "Call analysis failed — using fallback analysis");
    analysis = {
      intent: "needs_info",
      score: existingLead.score ?? 40,
      summary: sessionLanguage.startsWith("hi")
        ? "कॉल पूरी हुई — हमारी टीम जल्द ही आपसे संपर्क करेगी।"
        : "Call completed — our team will follow up with you shortly.",
      followupDate: null,
      followupReason: null,
      language: sessionLanguage.slice(0, 2) || "hi",
      familyInfo: null,
      preferredModel: null,
      objections: [],
      competitorMentioned: null,
      competitorReason: null,
      buyingTimeline: null,
      decisionMaker: null,
      lostDeal: false,
      lostToBrand: null,
      lostToDealer: null,
      lostReason: null,
      lostOfferFactor: null,
      visitPlanned: false,
      visitDate: null,
    };
  }
  const festival = await getActiveFestivalOffer();

  // Confirmed showroom visit / test ride → persist for the day-of reminder loop.
  const visitDate = analysis.visitPlanned ? parseLlmFollowupDate(analysis.visitDate) : null;
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

  try {
    const card = scoreCallShadow(transcript, {
      visitBooked: Boolean(visitDate || existingLead.visitScheduledAt || /\[VISIT\]/i.test(transcript)),
      transferred: /\[TRANSFER/i.test(transcript),
    });
    await db.insert(shadowScoresTable).values({
      callId: callDbId,
      leadId,
      completeness: card.completeness,
      grounding: card.grounding,
      booking: card.booking,
      handoff: card.handoff,
      talkRatio: card.talkRatio,
      fillerPenalty: card.fillerPenalty,
      overall: card.overall,
      notes: card.notes,
    });
  } catch (err) {
    logger.warn({ err, callDbId }, "Shadow score write failed");
  }

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

  // ── Relationship & Revenue Intelligence (Growth OS v2) ──────────────────────
  // Deterministic, no extra LLM call: derive relationship/trust/engagement/
  // loyalty/follow-up scores, purchase stage, persona, purchase probability and
  // revenue from data we already have. Failure here must never block the CRM
  // write or the customer's WhatsApp, so it is fully guarded.
  let intelPatch: Record<string, unknown> = {};
  try {
    const [{ value: completedCalls } = { value: 0 }] = await db
      .select({ value: count() })
      .from(callsTable)
      .where(and(eq(callsTable.leadId, leadId), eq(callsTable.status, "completed")));

    const modelForPrice = analysis.preferredModel ?? existingLead.interestedModel ?? null;
    const vehiclePrice = modelForPrice
      ? (resolveModelOnRoad(modelForPrice, modelForPrice)?.onRoad ?? null)
      : null;

    const intel = computeLeadIntelligence({
      intent: analysis.intent,
      callScore: analysis.score,
      objections: analysis.objections,
      competitorMentioned: analysis.competitorMentioned,
      buyingTimeline: mergedTimeline,
      decisionMaker: analysis.decisionMaker ?? discoverySignals.decisionMaker ?? null,
      visitPlanned: analysis.visitPlanned,
      lostDeal: analysis.lostDeal,
      segment: discoverySignals.segment ?? existingLead.segment ?? null,
      stylePreference: discoverySignals.stylePreference ?? null,
      budget: discoverySignals.budget ?? existingLead.budget ?? null,
      dailyKm: discoverySignals.km ?? existingLead.dailyKm ?? null,
      financeInterest: discoverySignals.financeInterest,
      exchangeInterest: discoverySignals.exchangeInterest,
      comparingBrands: discoverySignals.comparingBrands,
      readyToBuy: discoverySignals.readyToBuy,
      negotiating: discoverySignals.negotiating,
      familyUse: discoverySignals.familyUse,
      purpose: discoverySignals.purpose ?? null,
      currentVehicle: discoverySignals.currentVehicle ?? existingLead.currentVehicle ?? null,
      interestedModel: modelForPrice,
      completedCalls: completedCalls || 1,
      priorStatus: existingLead.status ?? null,
      vehiclePrice,
    });

    intelPatch = { ...intel, intelligenceUpdatedAt: new Date() };
  } catch (err) {
    logger.error({ err, leadId, callDbId }, "Relationship intelligence compute failed — skipping scores");
  }

  await db
    .update(leadsTable)
    .set({
      score: analysis.score,
      status: newStatus,
      language: analysis.language,
      ...intelPatch,
      intentSummary: analysis.summary,
      lastCallId: callDbId,
      ...(analysis.preferredModel
        ? { interestedModel: sql`COALESCE(${leadsTable.interestedModel}, ${analysis.preferredModel})` }
        : {}),
      ...(analysis.familyInfo ? { familyInfo: analysis.familyInfo } : {}),
      ...(analysis.competitorMentioned ? { competitorMentioned: analysis.competitorMentioned } : {}),
      ...(analysis.competitorReason ? { competitorReason: analysis.competitorReason } : {}),
      ...(mergedTimeline ? { buyingTimeline: mergedTimeline } : {}),
      ...(visitDate ? { visitScheduledAt: visitDate, visitReminderSentAt: null } : {}),
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

  // Follow-up scheduling must not block the WhatsApp sends below.
  try {
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
  } catch (err) {
    logger.error({ err, leadId, callDbId }, "Follow-up scheduling failed — continuing to WhatsApp");
  }

  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
  if (lead) {
    const modelOfInterest = analysis.preferredModel ?? lead.interestedModel;

    // On-road price + reference EMI line for the customer's model — the price
    // is what they asked about on the call; it belongs in the follow-up message.
    let priceLine: string | null = null;
    if (modelOfInterest) {
      const resolved = resolveModelOnRoad(modelOfInterest, modelOfInterest);
      if (resolved) {
        const down = 25000;
        const emi24 = computeEmi(resolved.onRoad - down, 24);
        priceLine = sessionLanguage.startsWith("hi")
          ? `💰 *${resolved.model}* — On-road Jaipur ₹${resolved.onRoad.toLocaleString("en-IN")}\n📊 EMI लगभग ₹${emi24.toLocaleString("en-IN")}/माह (₹${down.toLocaleString("en-IN")} down, 24 माह, 9% reference)`
          : `💰 *${resolved.model}* — On-road Jaipur ₹${resolved.onRoad.toLocaleString("en-IN")}\n📊 EMI approx ₹${emi24.toLocaleString("en-IN")}/month (₹${down.toLocaleString("en-IN")} down, 24 months, 9% reference)`;
      }
    }

    const sent = await sendCallSummaryWhatsApp(
      lead.phone,
      lead.name,
      analysis.summary,
      lead.interestedModel,
      sessionLanguage,
      priceLine,
    ).catch((err) => {
      logger.error({ err }, "WhatsApp summary failed");
      return false;
    });

    if (sent) {
      await db.update(callsTable).set({ whatsappSent: true }).where(eq(callsTable.id, callDbId));
    } else {
      logger.warn({ leadId, callDbId, phone: lead.phone }, "Post-call WhatsApp summary NOT sent — check BOTSPACE_API_KEY / BOTSPACE_PHONE_NUMBER_ID");
    }

    if (modelOfInterest) {
      // Prefer a brochure whose title mentions the model; fall back to any brochure.
      const brochures = await db
        .select()
        .from(knowledgeTable)
        .where(eq(knowledgeTable.category, "brochure"));
      const modelKey = modelOfInterest.toLowerCase().split(/\s+/)[0] ?? "";
      const brochure =
        brochures.find((b) => b.fileUrl && modelKey && b.title?.toLowerCase().includes(modelKey))
        ?? brochures.find((b) => b.fileUrl);
      if (brochure?.fileUrl) {
        await sendBrochureWhatsApp(
          lead.phone,
          lead.name,
          modelOfInterest,
          brochure.fileUrl,
          sessionLanguage,
        ).catch((err) => logger.error({ err }, "Brochure WhatsApp failed"));
      } else {
        logger.warn({ leadId, modelOfInterest }, "No brochure row with fileUrl in knowledge table (category='brochure') — brochure not sent");
      }
    }
  }

  await learnFromTranscript(transcript, analysis.summary, exotelCallSid ?? String(callDbId));
}
