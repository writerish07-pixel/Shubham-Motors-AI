import { Router, type IRouter } from "express";
import { eq, and, lte } from "drizzle-orm";
import { db, followupsTable, leadsTable, callsTable } from "@workspace/db";
import {
  ListFollowupsQueryParams,
  UpdateFollowupParams,
  UpdateFollowupBody,
  DeleteFollowupParams,
  ExecuteFollowupParams,
} from "@workspace/api-zod";
import { makeOutboundCall } from "../lib/exotel";
import { getWebhookBaseUrl } from "../lib/publicUrl";
import { setOutboundContext, type OutboundLeadContext } from "../lib/scheduler";
import { evaluateManualOutboundGates } from "../lib/agentActions";

const router: IRouter = Router();

router.get("/followups", async (req, res): Promise<void> => {
  const params = ListFollowupsQueryParams.safeParse(req.query);

  const followups = await db.select({
    id: followupsTable.id,
    leadId: followupsTable.leadId,
    leadName: leadsTable.name,
    leadPhone: leadsTable.phone,
    scheduledAt: followupsTable.scheduledAt,
    status: followupsTable.status,
    reason: followupsTable.reason,
    intentLabel: followupsTable.intentLabel,
    callId: followupsTable.callId,
    createdAt: followupsTable.createdAt,
    updatedAt: followupsTable.updatedAt,
  })
    .from(followupsTable)
    .leftJoin(leadsTable, eq(followupsTable.leadId, leadsTable.id))
    .orderBy(followupsTable.scheduledAt);

  let filtered = followups;
  if (params.success && params.data.status) {
    filtered = filtered.filter((f) => f.status === params.data.status);
  }
  if (params.success && params.data.dueToday) {
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    filtered = filtered.filter((f) => f.scheduledAt && new Date(f.scheduledAt) <= today);
  }

  res.json(filtered);
});

router.post("/followups", async (req, res): Promise<void> => {
  const body = req.body;
  if (!body.leadId || !body.scheduledAt || !body.reason) {
    res.status(400).json({ error: "leadId, scheduledAt, and reason are required" });
    return;
  }

  const [followup] = await db.insert(followupsTable).values({
    leadId: body.leadId,
    scheduledAt: new Date(body.scheduledAt),
    reason: body.reason,
    intentLabel: body.intentLabel ?? null,
    status: "pending",
  }).returning();

  // Update lead's nextFollowupAt
  await db.update(leadsTable)
    .set({ nextFollowupAt: new Date(body.scheduledAt) })
    .where(eq(leadsTable.id, body.leadId));

  res.status(201).json(followup);
});

router.patch("/followups/:id", async (req, res): Promise<void> => {
  const params = UpdateFollowupParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = UpdateFollowupBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const updateData: Record<string, unknown> = {};
  if (body.data.scheduledAt) updateData["scheduledAt"] = new Date(body.data.scheduledAt);
  if (body.data.status) updateData["status"] = body.data.status;
  if (body.data.reason) updateData["reason"] = body.data.reason;

  const [followup] = await db.update(followupsTable)
    .set(updateData)
    .where(eq(followupsTable.id, params.data.id))
    .returning();

  if (!followup) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(followup);
});

router.delete("/followups/:id", async (req, res): Promise<void> => {
  const params = DeleteFollowupParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await db.delete(followupsTable).where(eq(followupsTable.id, params.data.id));
  res.sendStatus(204);
});

router.post("/followups/:id/execute", async (req, res): Promise<void> => {
  const params = ExecuteFollowupParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const [followup] = await db.select().from(followupsTable).where(eq(followupsTable.id, params.data.id));
  if (!followup) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, followup.leadId));
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  const gates = await evaluateManualOutboundGates(lead);
  if (!gates.ok) {
    res.status(409).json({ error: gates.reason, success: false });
    return;
  }

  const host = getWebhookBaseUrl();

  const storedCtx = followup.outboundContext as OutboundLeadContext | null;
  const ctx: OutboundLeadContext = storedCtx ?? {
    name: lead.name,
    interestedModel: lead.interestedModel,
    notes: lead.notes,
    lastCallSummary: lead.intentSummary,
    followupReason: followup.reason,
  };
  setOutboundContext(lead.phone, ctx);

  const callSid = await makeOutboundCall(lead.phone, host);

  if (callSid) {
    const [newCall] = await db.insert(callsTable).values({
      leadId: lead.id,
      direction: "outbound",
      status: "initiated",
      exotelCallSid: callSid,
    }).returning();

    await db.update(followupsTable)
      .set({
        status: "dialing",
        callId: newCall?.id ?? followup.callId,
        lastAttemptAt: new Date(),
        attemptCount: (followup.attemptCount ?? 0) + 1,
      })
      .where(eq(followupsTable.id, params.data.id));
  }

  res.json({ success: !!callSid, message: callSid ? "Follow-up call initiated" : "Failed", callSid: callSid ?? null });
});

export default router;
