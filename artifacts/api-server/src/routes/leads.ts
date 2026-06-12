import { Router, type IRouter } from "express";
import { eq, ilike, or, and } from "drizzle-orm";
import { db, leadsTable } from "@workspace/db";
import {
  ListLeadsQueryParams,
  GetLeadParams,
  UpdateLeadParams,
  UpdateLeadBody,
  DeleteLeadParams,
  TriggerOutboundCallParams,
} from "@workspace/api-zod";
import { makeOutboundCall } from "../lib/exotel";
import { getWebhookBaseUrl } from "../lib/publicUrl";
import { normalizePhone } from "../lib/phone";
import { setOutboundContext } from "../lib/scheduler";
import { triggerInstantLeadCall, isInstantCallSource } from "../lib/leadTrigger";

const router: IRouter = Router();

router.get("/leads", async (req, res): Promise<void> => {
  const params = ListLeadsQueryParams.safeParse(req.query);
  let query = db.select().from(leadsTable);

  const conditions = [];
  if (params.success) {
    if (params.data.status) {
      conditions.push(eq(leadsTable.status, params.data.status));
    }
    if (params.data.search) {
      const s = `%${params.data.search}%`;
      conditions.push(or(ilike(leadsTable.name, s), ilike(leadsTable.phone, s)));
    }
  }

  const leads = conditions.length > 0
    ? await db.select().from(leadsTable).where(and(...conditions))
    : await db.select().from(leadsTable);

  res.json(leads);
});

router.post("/leads", async (req, res): Promise<void> => {
  const body = req.body;
  if (!body.name || !body.phone) {
    res.status(400).json({ error: "name and phone are required" });
    return;
  }
  const phone = normalizePhone(body.phone);
  if (!phone) {
    res.status(400).json({ error: "invalid phone number" });
    return;
  }
  const [lead] = await db.insert(leadsTable).values({
    name: body.name,
    phone,
    email: body.email ?? null,
    interestedModel: body.interestedModel ?? null,
    source: body.source ?? null,
    notes: body.notes ?? null,
    status: "new",
    score: 0,
  }).returning();

  // Speed-to-lead: live enquiry sources get an instant first-response call
  // (within the TRAI calling window) — see leadTrigger.ts for the research.
  if (lead && isInstantCallSource(body.source)) {
    void triggerInstantLeadCall(lead.id);
  }

  res.status(201).json(lead);
});

router.post("/leads/import", async (req, res): Promise<void> => {
  const { leads } = req.body;
  if (!Array.isArray(leads)) {
    res.status(400).json({ error: "leads must be an array" });
    return;
  }
  let imported = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const l of leads) {
    if (!l.name || !l.phone) {
      failed++;
      errors.push(`Missing name or phone for: ${JSON.stringify(l)}`);
      continue;
    }
    try {
      const phone = normalizePhone(l.phone);
      if (!phone) throw new Error("invalid phone");
      await db.insert(leadsTable).values({
        name: l.name,
        phone,
        email: l.email ?? null,
        interestedModel: l.interestedModel ?? null,
        source: l.source ?? "import",
        notes: l.notes ?? null,
        status: "new",
        score: 0,
      }).onConflictDoUpdate({
        target: leadsTable.phone,
        set: {
          name: l.name,
          email: l.email ?? null,
          interestedModel: l.interestedModel ?? null,
          notes: l.notes ?? null,
          updatedAt: new Date(),
        },
      });
      imported++;
    } catch (err) {
      failed++;
      errors.push(`Failed to import ${l.name}: ${err}`);
    }
  }

  res.json({ imported, failed, total: leads.length, errors });
});

router.get("/leads/:id", async (req, res): Promise<void> => {
  const params = GetLeadParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, params.data.id));
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  res.json(lead);
});

router.patch("/leads/:id", async (req, res): Promise<void> => {
  const params = UpdateLeadParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = UpdateLeadBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const updateData: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body.data)) {
    if (v !== undefined) updateData[k] = v;
  }

  const [lead] = await db.update(leadsTable)
    .set(updateData)
    .where(eq(leadsTable.id, params.data.id))
    .returning();

  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  res.json(lead);
});

router.delete("/leads/:id", async (req, res): Promise<void> => {
  const params = DeleteLeadParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await db.delete(leadsTable).where(eq(leadsTable.id, params.data.id));
  res.sendStatus(204);
});

router.post("/leads/:id/call", async (req, res): Promise<void> => {
  const params = TriggerOutboundCallParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, params.data.id));
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  const host = getWebhookBaseUrl();

  setOutboundContext(lead.phone, {
    name: lead.name,
    interestedModel: lead.interestedModel,
    notes: lead.notes,
    lastCallSummary: lead.intentSummary,
    followupReason: "Manual outbound call from CRM",
  });

  const callSid = await makeOutboundCall(lead.phone, host);
  if (callSid) {
    const { callsTable } = await import("@workspace/db");
    await db.insert(callsTable).values({
      leadId: lead.id,
      direction: "outbound",
      status: "initiated",
      exotelCallSid: callSid,
    });
  }

  res.json({ success: !!callSid, message: callSid ? "Call initiated" : "Failed to initiate call", callSid: callSid ?? null });
});

export default router;
