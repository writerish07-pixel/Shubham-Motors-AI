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
import { analyzeCallIntent, learnFromTranscript } from "../lib/openai";

const router: IRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
// Whisper accepts up to 25 MB; allow up to 25 MB for historical recordings.
const uploadAudio = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

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

// ─── Offer image upload: OCR + understand a marketing flyer via GPT-4o vision ──
// Accepts JPG/PNG/WebP/PDF-as-image, extracts structured offer text using
// vision, and writes it into the KB as an "offer" row. The agent can then
// quote the exact amounts and conditions on calls.
router.post("/knowledge/upload/offer-image", upload.single("file"), async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  if (!req.file) { res.status(400).json({ error: "image file required" }); return; }
  const mime = (req.file.mimetype || "").toLowerCase();
  const ALLOWED = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"];
  if (!ALLOWED.includes(mime)) {
    res.status(400).json({ error: `unsupported file type "${mime}" — please upload a JPG, PNG, WebP or GIF image (PDFs not supported)` });
    return;
  }
  try {
    const { default: OpenAI } = await import("openai");
    const openai = new OpenAI({
      apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
      baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
    });
    const b64 = req.file.buffer.toString("base64");
    const dataUrl = `data:${mime};base64,${b64}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                `You are reading a Hero MotoCorp dealer marketing image (offer flyer, scheme, EMI poster, festival promo, etc.). ` +
                `Extract every actionable offer detail and return JSON:\n` +
                `{\n` +
                `  "items": [\n` +
                `    {\n` +
                `      "title": "<short — e.g. 'Pine Labs EMI Offer (May 2026)'>",\n` +
                `      "content": "<concise but COMPLETE — every rupee amount, percentage, condition, eligible bank/card, applicable bike models, minimum txn, tenure, validity dates. If a % is given, ALSO compute and state the rupee amount on at least one example Hero bike price (e.g. Splendor ₹74,000 or whichever model is most relevant). Be precise.>"\n` +
                `    }\n` +
                `  ]\n` +
                `}\n` +
                `Multiple distinct offers in one image → multiple items. If the image is not a Hero offer, return {"items":[]}.`,
            },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_tokens: 800,
    });

    const parsed = JSON.parse(completion.choices[0]?.message?.content ?? "{}");
    const items: Array<{ title: string; content: string }> = parsed.items ?? [];
    if (items.length === 0) {
      res.status(400).json({ error: "no offer details extracted — try a clearer image" });
      return;
    }

    const inserts = items
      .filter((it) => it.title && it.content)
      .map((it) => ({
        title: it.title.slice(0, 120),
        content: it.content.slice(0, 2000),
        category: "offer",
        isActive: true,
      }));
    if (inserts.length === 0) {
      res.status(400).json({ error: "extracted items missing title/content" });
      return;
    }

    await db.insert(knowledgeTable).values(inserts);
    res.json({ ok: true, items: inserts, source: req.file.originalname });
  } catch (err) {
    res.status(500).json({ error: String((err as Error).message) });
  }
});

router.get("/knowledge", async (req, res): Promise<void> => {
  const params = ListKnowledgeItemsQueryParams.safeParse(req.query);
  let items = await db.select().from(knowledgeTable).orderBy(knowledgeTable.category);

  // Hide self-learning review-pending items from the main KB list by default.
  // The Pending Review UI uses GET /knowledge/pending explicitly.
  items = items.filter((i) => !i.requiresReview);

  if (params.success && params.data.category) {
    items = items.filter((i) => i.category === params.data.category);
  }

  res.json(items);
});

// ─── Historical call recording upload → Whisper STT → self-learning queue ─────
// Accepts MP3/WAV/M4A/OGG up to 25 MB. Transcribes via OpenAI Whisper, then
// feeds into the same learnFromTranscript pipeline as live calls. Resulting
// insights go into the review queue (isActive=false, requiresReview=true),
// tagged with source="upload:<filename>" for provenance.
router.post("/knowledge/upload/recording", uploadAudio.single("file"), async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  if (!req.file) { res.status(400).json({ error: "audio file required" }); return; }
  const mime = (req.file.mimetype || "").toLowerCase();
  const ALLOWED = ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave", "audio/mp4", "audio/m4a", "audio/x-m4a", "audio/ogg", "audio/webm"];
  if (!ALLOWED.some((a) => mime.startsWith(a))) {
    res.status(400).json({ error: `unsupported audio type "${mime}" — please upload MP3, WAV, M4A, OGG, or WebM` });
    return;
  }
  try {
    const { default: OpenAI } = await import("openai");
    const { toFile } = await import("openai/uploads");
    const openai = new OpenAI({
      apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
      baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
    });

    const file = await toFile(req.file.buffer, req.file.originalname, { type: mime });
    const tx = await openai.audio.transcriptions.create({
      file,
      model: "whisper-1",
    });
    const transcript = (tx.text ?? "").trim();
    if (transcript.length < 20) {
      res.status(400).json({ error: "transcript too short — recording may be silent or corrupt" });
      return;
    }

    const analysis = await analyzeCallIntent(transcript);
    const source = `upload:${req.file.originalname}`;
    const beforeCount = (await db.select({ id: knowledgeTable.id }).from(knowledgeTable)
      .where(eq(knowledgeTable.requiresReview, true))).length;
    await learnFromTranscript(transcript, analysis.summary ?? "Historical recording", source);
    const afterCount = (await db.select({ id: knowledgeTable.id }).from(knowledgeTable)
      .where(eq(knowledgeTable.requiresReview, true))).length;

    res.json({
      ok: true,
      filename: req.file.originalname,
      transcriptChars: transcript.length,
      summary: analysis.summary,
      itemsQueuedForReview: afterCount - beforeCount,
    });
  } catch (err) {
    res.status(500).json({ error: String((err as Error).message) });
  }
});

// ─── Bulk export / import for dev → prod KB sync (admin only) ─────────────────
// SAFE ALLOWLIST: only curated KB fields are exported/imported. Review-queue
// fields (requiresReview, evidence, source) and pending rows are excluded so
// unreviewed call-derived data never propagates between environments. The
// review queue must be approved in each environment independently.
const KB_SAFE_FIELDS = ["id", "title", "category", "content", "modelName", "fileUrl", "isActive", "createdAt", "updatedAt"] as const;
const MAX_IMPORT_ROWS = 5000;

router.get("/knowledge/export", async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const rows = await db.select().from(knowledgeTable)
    .where(eq(knowledgeTable.requiresReview, false));
  const items = rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const k of KB_SAFE_FIELDS) out[k] = (r as Record<string, unknown>)[k];
    return out;
  });
  res.setHeader("Content-Disposition", `attachment; filename="knowledge-export-${new Date().toISOString().slice(0,10)}.json"`);
  res.json({ exportedAt: new Date().toISOString(), count: items.length, items });
});

router.post("/knowledge/import", async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const body = req.body ?? {};
  const items: unknown[] = Array.isArray(body.items) ? body.items : [];
  const mode: "replace" | "merge" = body.mode === "replace" ? "replace" : "merge";
  if (items.length === 0) { res.status(400).json({ error: "items[] required (use export format)" }); return; }
  if (items.length > MAX_IMPORT_ROWS) { res.status(413).json({ error: `too many rows (${items.length}); max ${MAX_IMPORT_ROWS}` }); return; }

  // Always force imported rows to be live KB entries — never pending review,
  // never carry transcript evidence or call sids across environments.
  const normalized = items
    .filter((it): it is Record<string, unknown> => typeof it === "object" && it !== null)
    .map((it) => ({
      title: String(it.title ?? "").slice(0, 200),
      category: String(it.category ?? "general").slice(0, 50),
      content: String(it.content ?? "").slice(0, 5000),
      modelName: it.modelName ? String(it.modelName).slice(0, 100) : null,
      fileUrl: it.fileUrl ? String(it.fileUrl).slice(0, 500) : null,
      isActive: it.isActive === false ? false : true,
      requiresReview: false as const,
      evidence: null,
      source: null,
    }))
    .filter((it) => it.title && it.content);

  if (normalized.length === 0) { res.status(400).json({ error: "no valid rows in payload" }); return; }

  await db.transaction(async (tx) => {
    if (mode === "replace") {
      // Replace only the curated KB; leave the local review queue untouched.
      await tx.delete(knowledgeTable).where(eq(knowledgeTable.requiresReview, false));
    }
    const CHUNK = 100;
    for (let i = 0; i < normalized.length; i += CHUNK) {
      await tx.insert(knowledgeTable).values(normalized.slice(i, i + CHUNK));
    }
  });

  res.json({ ok: true, mode, imported: normalized.length });
});

// ─── Self-learning review queue (admin only — pending rows may contain call transcript snippets) ─
router.get("/knowledge/pending", async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const items = await db.select().from(knowledgeTable)
    .where(eq(knowledgeTable.requiresReview, true))
    .orderBy(knowledgeTable.createdAt);
  res.json(items);
});

// Approve only constrains to requiresReview=true so this endpoint can't be used
// to flip arbitrary KB rows back to active.
router.post("/knowledge/:id/approve", async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "invalid id" }); return; }
  const { and } = await import("drizzle-orm");
  const [item] = await db.update(knowledgeTable)
    .set({ requiresReview: false, isActive: true })
    .where(and(eq(knowledgeTable.id, id), eq(knowledgeTable.requiresReview, true)))
    .returning();
  if (!item) { res.status(404).json({ error: "not found or not pending review" }); return; }
  res.json(item);
});

// Reject only deletes review-pending rows, so this endpoint can't be used to
// nuke production KB entries.
router.post("/knowledge/:id/reject", async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "invalid id" }); return; }
  const { and } = await import("drizzle-orm");
  const deleted = await db.delete(knowledgeTable)
    .where(and(eq(knowledgeTable.id, id), eq(knowledgeTable.requiresReview, true)))
    .returning({ id: knowledgeTable.id });
  if (deleted.length === 0) { res.status(404).json({ error: "not found or not pending review" }); return; }
  res.sendStatus(204);
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
