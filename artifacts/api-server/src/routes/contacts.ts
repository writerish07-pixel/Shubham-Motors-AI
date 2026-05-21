import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, contactsTable } from "@workspace/db";

const router: IRouter = Router();

// Contacts hold private phone numbers used for live call transfer — protect
// EVERY route (including GET) with the same admin token used for KB uploads.
function requireAdmin(req: import("express").Request, res: import("express").Response): boolean {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) { res.status(503).json({ error: "ADMIN_TOKEN not configured on server" }); return false; }
  const got = String(req.headers["x-admin-token"] ?? "").trim() ||
    String(req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "").trim();
  if (got !== expected) { res.status(401).json({ error: "unauthorized" }); return false; }
  return true;
}

const CreateBody = z.object({
  type: z.enum(["sales", "finance"]),
  name: z.string().min(1).max(120),
  phone: z.string().min(7).max(20),
  bankName: z.string().max(120).nullable().optional(),
  isActive: z.boolean().optional(),
});

const UpdateBody = CreateBody.partial();

router.get("/contacts", async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const type = String(req.query.type ?? "").trim();
  const all = await db.select().from(contactsTable).orderBy(contactsTable.type, contactsTable.name);
  const filtered = type === "sales" || type === "finance" ? all.filter(c => c.type === type) : all;
  res.json(filtered);
});

router.post("/contacts", async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const parsed = CreateBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const d = parsed.data;
  // Normalise phone to digits-only (last 10 for Indian mobile, keep + for intl)
  const phone = d.phone.replace(/[^\d+]/g, "");
  const [item] = await db.insert(contactsTable).values({
    type: d.type,
    name: d.name.trim(),
    phone,
    bankName: d.type === "finance" ? (d.bankName ?? null) : null,
    isActive: d.isActive ?? true,
  }).returning();
  res.status(201).json(item);
});

router.patch("/contacts/:id", async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const id = parseInt(req.params.id ?? "", 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "invalid id" }); return; }
  const parsed = UpdateBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const upd: Record<string, unknown> = { ...parsed.data };
  if (typeof upd.phone === "string") upd.phone = (upd.phone as string).replace(/[^\d+]/g, "");
  const [item] = await db.update(contactsTable).set(upd).where(eq(contactsTable.id, id)).returning();
  if (!item) { res.status(404).json({ error: "not found" }); return; }
  res.json(item);
});

router.delete("/contacts/:id", async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const id = parseInt(req.params.id ?? "", 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "invalid id" }); return; }
  await db.delete(contactsTable).where(eq(contactsTable.id, id));
  res.sendStatus(204);
});

export default router;
