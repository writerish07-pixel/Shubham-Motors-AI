import { Router, type IRouter } from "express";
import { and, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import { db, leadsTable, visitBookingsTable, visitSlotsTable } from "@workspace/db";
import { bookNextOpenSlot } from "../lib/agentActions";

const router: IRouter = Router();

function requireAdmin(req: import("express").Request, res: import("express").Response): boolean {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) { res.status(503).json({ error: "ADMIN_TOKEN not configured on server" }); return false; }
  const got = String(req.headers["x-admin-token"] ?? "").trim() ||
    String(req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "").trim();
  if (got !== expected) { res.status(401).json({ error: "unauthorized" }); return false; }
  return true;
}

router.get("/visits/slots", async (req, res): Promise<void> => {
  const from = req.query.from ? new Date(String(req.query.from)) : new Date();
  const to = req.query.to ? new Date(String(req.query.to)) : new Date(Date.now() + 14 * 24 * 3600_000);
  const slots = await db
    .select()
    .from(visitSlotsTable)
    .where(and(gte(visitSlotsTable.startsAt, from), lte(visitSlotsTable.startsAt, to)))
    .orderBy(visitSlotsTable.startsAt);
  res.json(slots);
});

router.post("/visits/slots", async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const startsAt = req.body?.startsAt ? new Date(req.body.startsAt) : null;
  if (!startsAt || Number.isNaN(startsAt.getTime())) {
    res.status(400).json({ error: "startsAt required (ISO datetime)" });
    return;
  }
  const capacity = Math.max(1, Number(req.body?.capacity) || 1);
  const label = req.body?.label ? String(req.body.label).slice(0, 80) : null;
  try {
    const [slot] = await db.insert(visitSlotsTable).values({ startsAt, capacity, label }).returning();
    res.status(201).json(slot);
  } catch (err) {
    res.status(409).json({ error: "slot already exists for that time", detail: String((err as Error).message) });
  }
});

router.delete("/visits/slots/:id", async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "invalid id" }); return; }
  await db.delete(visitSlotsTable).where(eq(visitSlotsTable.id, id));
  res.sendStatus(204);
});

/** Generate Mon–Sat (or custom) slots for the next 14 IST days. */
router.post("/visits/generate-week", async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const times: string[] = Array.isArray(req.body?.times) ? req.body.times : ["11:00", "16:00"];
  const weekdays: number[] = Array.isArray(req.body?.weekdays) ? req.body.weekdays.map(Number) : [1, 2, 3, 4, 5, 6];
  const capacity = Math.max(1, Number(req.body?.capacity) || 1);
  const created: unknown[] = [];
  const now = new Date();

  for (let d = 0; d < 14; d++) {
    const istMs = now.getTime() + 5.5 * 3600_000 + d * 24 * 3600_000;
    const ist = new Date(istMs);
    const isoDay = ist.getUTCDay() === 0 ? 7 : ist.getUTCDay();
    if (!weekdays.includes(isoDay)) continue;
    const y = ist.getUTCFullYear();
    const m = ist.getUTCMonth();
    const day = ist.getUTCDate();
    for (const t of times) {
      const [hh, mm] = String(t).split(":").map(Number);
      if (!Number.isFinite(hh) || !Number.isFinite(mm)) continue;
      const utc = new Date(Date.UTC(y, m, day, hh, mm, 0) - 5.5 * 3600_000);
      if (utc <= now) continue;
      try {
        const [slot] = await db.insert(visitSlotsTable).values({
          startsAt: utc,
          capacity,
          label: "showroom",
        }).returning();
        created.push(slot);
      } catch {
        // unique startsAt — skip duplicates
      }
    }
  }
  res.json({ ok: true, created: created.length, slots: created });
});

router.get("/visits/bookings", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: visitBookingsTable.id,
      status: visitBookingsTable.status,
      createdAt: visitBookingsTable.createdAt,
      slotId: visitBookingsTable.slotId,
      startsAt: visitSlotsTable.startsAt,
      leadId: visitBookingsTable.leadId,
      leadName: leadsTable.name,
      leadPhone: leadsTable.phone,
      interestedModel: leadsTable.interestedModel,
    })
    .from(visitBookingsTable)
    .leftJoin(visitSlotsTable, eq(visitBookingsTable.slotId, visitSlotsTable.id))
    .leftJoin(leadsTable, eq(visitBookingsTable.leadId, leadsTable.id))
    .orderBy(desc(visitBookingsTable.createdAt))
    .limit(100);
  res.json(rows);
});

router.post("/visits/book", async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const slotId = Number(req.body?.slotId);
  const leadId = Number(req.body?.leadId);
  if (!slotId || !leadId) { res.status(400).json({ error: "slotId and leadId required" }); return; }

  const [slot] = await db.select().from(visitSlotsTable).where(eq(visitSlotsTable.id, slotId));
  if (!slot) { res.status(404).json({ error: "slot not found" }); return; }
  if (slot.bookedCount >= slot.capacity) { res.status(409).json({ error: "slot full" }); return; }

  const updated = await db.update(visitSlotsTable)
    .set({ bookedCount: sql`${visitSlotsTable.bookedCount} + 1` })
    .where(and(eq(visitSlotsTable.id, slotId), lt(visitSlotsTable.bookedCount, visitSlotsTable.capacity)))
    .returning();
  if (updated.length === 0) { res.status(409).json({ error: "slot full" }); return; }

  const [booking] = await db.insert(visitBookingsTable).values({ slotId, leadId, status: "booked" }).returning();
  await db.update(leadsTable).set({ visitScheduledAt: slot.startsAt }).where(eq(leadsTable.id, leadId));
  res.status(201).json(booking);
});

router.post("/visits/book/next", async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const leadId = Number(req.body?.leadId);
  if (!leadId) { res.status(400).json({ error: "leadId required" }); return; }
  const preferred = req.body?.preferredAt ? new Date(req.body.preferredAt) : undefined;
  const booked = await bookNextOpenSlot(leadId, preferred && !Number.isNaN(preferred.getTime()) ? preferred : undefined);
  if (!booked) { res.status(409).json({ error: "no open slots in the next 14 days — generate a week first" }); return; }
  res.status(201).json(booked);
});

router.post("/visits/bookings/:id/cancel", async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "invalid id" }); return; }
  const [booking] = await db.select().from(visitBookingsTable).where(eq(visitBookingsTable.id, id));
  if (!booking) { res.status(404).json({ error: "not found" }); return; }
  if (booking.status !== "booked") { res.json(booking); return; }

  await db.update(visitBookingsTable).set({ status: "cancelled" }).where(eq(visitBookingsTable.id, id));
  await db.update(visitSlotsTable)
    .set({ bookedCount: sql`GREATEST(${visitSlotsTable.bookedCount} - 1, 0)` })
    .where(eq(visitSlotsTable.id, booking.slotId));
  await db.update(leadsTable).set({ visitScheduledAt: null }).where(eq(leadsTable.id, booking.leadId));
  res.json({ ok: true });
});

export default router;
