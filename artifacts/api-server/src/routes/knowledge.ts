import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import multer from "multer";
import XLSX from "xlsx";
import { db, knowledgeTable } from "@workspace/db";
import {
  ListKnowledgeItemsQueryParams,
  UpdateKnowledgeItemParams,
  UpdateKnowledgeItemBody,
  DeleteKnowledgeItemParams,
} from "@workspace/api-zod";

const router: IRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Lightweight admin guard for KB-mutating uploads. Set ADMIN_TOKEN in env;
// callers must send `X-Admin-Token: <token>` (or `Authorization: Bearer <token>`).
// If ADMIN_TOKEN is unset we deny by default so an empty env can't be exploited.
function requireAdmin(req: import("express").Request, res: import("express").Response): boolean {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) { res.status(503).json({ error: "ADMIN_TOKEN not configured on server" }); return false; }
  const got = String(req.headers["x-admin-token"] ?? "").trim() ||
    String(req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "").trim();
  if (got !== expected) { res.status(401).json({ error: "unauthorized" }); return false; }
  return true;
}

// ─── Daily stock upload: wipes old stock rows then ingests fresh Excel ────────
// Expected columns: Model | SKU | SKU Description | SKU wise Inventory Qty
router.post("/knowledge/upload/stock", upload.single("file"), async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  if (!req.file) { res.status(400).json({ error: "file required" }); return; }
  try {
    const wb = XLSX.read(req.file.buffer, { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets[wb.SheetNames[0]!]!, { defval: "", raw: false });

    const byModel: Record<string, { total: number; variants: string[] }> = {};
    for (const r of rows) {
      const m = String(r["Model"] ?? "").trim();
      if (!m) continue;
      const qty = parseInt(String(r["SKU wise Inventory Qty"] ?? "0"), 10) || 0;
      byModel[m] ??= { total: 0, variants: [] };
      byModel[m]!.total += qty;
      if (qty > 0) byModel[m]!.variants.push(`${r["SKU Description"]} (Qty: ${qty})`);
    }

    const inserts = Object.entries(byModel).map(([m, d]) => ({
      title: m, category: "stock", isActive: true,
      content: `Total in stock: ${d.total}. Variants: ${d.variants.slice(0, 8).join("; ")}`,
    }));
    if (inserts.length === 0) {
      res.status(400).json({ error: "no valid stock rows found — refusing to wipe existing KB" });
      return;
    }
    // Atomic: only delete existing once we have valid rows to insert
    await db.transaction(async (tx) => {
      await tx.delete(knowledgeTable).where(eq(knowledgeTable.category, "stock"));
      await tx.insert(knowledgeTable).values(inserts);
    });
    res.json({ ok: true, models: inserts.length, source: req.file.originalname });
  } catch (err) {
    res.status(500).json({ error: String((err as Error).message) });
  }
});

// ─── Price list upload (monthly): wipes old price rows then ingests fresh Excel ──
// Headers in row 1 (first data row): S.NO. | MODEL | EX. SHOWROOM | RC | Insurance with N.D | Standard ACC. | On Road Price | ACC.KIT | Total
router.post("/knowledge/upload/price", upload.single("file"), async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  if (!req.file) { res.status(400).json({ error: "file required" }); return; }
  try {
    const wb = XLSX.read(req.file.buffer, { type: "buffer" });
    const raw = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]!]!, { defval: "", raw: false, header: 1 });

    // Find the real header row: the row whose cell-1 text matches /MODEL/i and
    // whose cell-2 text contains /SHOWROOM/i. This handles sheets that start
    // with a date row before the real headers.
    let headerIdx = -1;
    for (let i = 0; i < Math.min(raw.length, 5); i++) {
      const r = raw[i] ?? [];
      if (/MODEL/i.test(String(r[1] ?? "")) && /SHOWROOM/i.test(String(r[2] ?? ""))) {
        headerIdx = i;
        break;
      }
    }
    if (headerIdx === -1) {
      res.status(400).json({ error: "header row not found — expected MODEL/EX. SHOWROOM columns" });
      return;
    }

    const rows = raw.slice(headerIdx + 1).filter((r) => {
      const model = String(r[1] ?? "").trim();
      const price = String(r[2] ?? "").trim();
      // Reject obvious non-data rows
      if (!model || !price) return false;
      if (/^MODEL$/i.test(model)) return false;            // duplicated header
      if (!/^\d[\d,.]*$/.test(price)) return false;        // price must be numeric
      return true;
    });

    const inserts = rows.map((r) => ({
      title: String(r[1]).trim(), category: "price", isActive: true,
      content: `Ex-showroom: Rs.${r[2]} | RC: Rs.${r[3]} | Insurance: Rs.${r[4]} | On-road: Rs.${r[6]} | With Accessory Kit: Rs.${r[8]}`,
    }));
    if (inserts.length === 0) {
      res.status(400).json({ error: "no valid price rows found — refusing to wipe existing KB" });
      return;
    }
    await db.transaction(async (tx) => {
      await tx.delete(knowledgeTable).where(eq(knowledgeTable.category, "price"));
      await tx.insert(knowledgeTable).values(inserts);
    });
    res.json({ ok: true, models: inserts.length, source: req.file.originalname });
  } catch (err) {
    res.status(500).json({ error: String((err as Error).message) });
  }
});

router.get("/knowledge", async (req, res): Promise<void> => {
  const params = ListKnowledgeItemsQueryParams.safeParse(req.query);
  let items = await db.select().from(knowledgeTable).orderBy(knowledgeTable.category);

  if (params.success && params.data.category) {
    items = items.filter((i) => i.category === params.data.category);
  }

  res.json(items);
});

router.post("/knowledge", async (req, res): Promise<void> => {
  const body = req.body;
  if (!body.title || !body.category || !body.content) {
    res.status(400).json({ error: "title, category, and content are required" });
    return;
  }

  const [item] = await db.insert(knowledgeTable).values({
    title: body.title,
    category: body.category,
    content: body.content,
    modelName: body.modelName ?? null,
    fileUrl: body.fileUrl ?? null,
    isActive: true,
  }).returning();

  res.status(201).json(item);
});

router.patch("/knowledge/:id", async (req, res): Promise<void> => {
  const params = UpdateKnowledgeItemParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = UpdateKnowledgeItemBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [item] = await db.update(knowledgeTable)
    .set(body.data)
    .where(eq(knowledgeTable.id, params.data.id))
    .returning();

  if (!item) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(item);
});

router.delete("/knowledge/:id", async (req, res): Promise<void> => {
  const params = DeleteKnowledgeItemParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await db.delete(knowledgeTable).where(eq(knowledgeTable.id, params.data.id));
  res.sendStatus(204);
});

export default router;
