import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, callsTable, leadsTable } from "@workspace/db";
import {
  GetCallParams,
  ListCallsQueryParams,
  TransferCallParams,
  TransferCallBody,
} from "@workspace/api-zod";
import { transferCallToAgent } from "../lib/exotel";

const router: IRouter = Router();

router.get("/calls", async (req, res): Promise<void> => {
  const params = ListCallsQueryParams.safeParse(req.query);

  const calls = await db.select({
    id: callsTable.id,
    leadId: callsTable.leadId,
    leadName: leadsTable.name,
    leadPhone: leadsTable.phone,
    direction: callsTable.direction,
    status: callsTable.status,
    duration: callsTable.duration,
    transcript: callsTable.transcript,
    summary: callsTable.summary,
    intentDetected: callsTable.intentDetected,
    scoreAfterCall: callsTable.scoreAfterCall,
    languageDetected: callsTable.languageDetected,
    whatsappSent: callsTable.whatsappSent,
    transferredTo: callsTable.transferredTo,
    exotelCallSid: callsTable.exotelCallSid,
    createdAt: callsTable.createdAt,
    updatedAt: callsTable.updatedAt,
  })
    .from(callsTable)
    .leftJoin(leadsTable, eq(callsTable.leadId, leadsTable.id))
    .orderBy(callsTable.createdAt);

  let filtered = calls;
  if (params.success && params.data.leadId) {
    filtered = calls.filter((c) => c.leadId === Number(params.data.leadId));
  }
  if (params.success && params.data.status) {
    filtered = filtered.filter((c) => c.status === params.data.status);
  }

  res.json(filtered);
});

router.get("/calls/:id", async (req, res): Promise<void> => {
  const params = GetCallParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const [call] = await db.select({
    id: callsTable.id,
    leadId: callsTable.leadId,
    leadName: leadsTable.name,
    leadPhone: leadsTable.phone,
    direction: callsTable.direction,
    status: callsTable.status,
    duration: callsTable.duration,
    transcript: callsTable.transcript,
    summary: callsTable.summary,
    intentDetected: callsTable.intentDetected,
    scoreAfterCall: callsTable.scoreAfterCall,
    languageDetected: callsTable.languageDetected,
    whatsappSent: callsTable.whatsappSent,
    transferredTo: callsTable.transferredTo,
    exotelCallSid: callsTable.exotelCallSid,
    createdAt: callsTable.createdAt,
    updatedAt: callsTable.updatedAt,
  })
    .from(callsTable)
    .leftJoin(leadsTable, eq(callsTable.leadId, leadsTable.id))
    .where(eq(callsTable.id, params.data.id));

  if (!call) {
    res.status(404).json({ error: "Call not found" });
    return;
  }
  res.json(call);
});

router.post("/calls/:id/transfer", async (req, res): Promise<void> => {
  const params = TransferCallParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = TransferCallBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "salesPersonNumber required" });
    return;
  }

  const [call] = await db.select().from(callsTable).where(eq(callsTable.id, params.data.id));
  if (!call) {
    res.status(404).json({ error: "Call not found" });
    return;
  }

  const success = call.exotelCallSid
    ? await transferCallToAgent(call.exotelCallSid, body.data.salesPersonNumber)
    : false;

  if (success) {
    await db.update(callsTable)
      .set({ status: "transferred", transferredTo: body.data.salesPersonNumber })
      .where(eq(callsTable.id, params.data.id));
  }

  res.json({ success, message: success ? "Call transferred" : "Transfer failed", callSid: call.exotelCallSid ?? null });
});

export default router;
