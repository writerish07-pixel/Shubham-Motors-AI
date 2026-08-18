import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import multer from "multer";
import XLSX from "xlsx";
import { db, knowledgeTable } from "@workspace/db";
import {
  ListKnowledgeItemsQueryParams,
  UpdateKnowledgeItemParams,
  UpdateKnowledgeItemBody,
  DeleteKnowledgeItemParams,
} from "@workspace/api-zod";
import { analyzeCallIntent, learnFromTranscript, invalidateKnowledgeCache } from "../lib/openai";
import { inferAudioMime, isUnsupportedAudioError, WHISPER_HINT, WHISPER_LANGUAGE, whisperFilename } from "../lib/audioUpload";
import { logger } from "../lib/logger";
import { syncCanonicalKnowledgeOnce } from "../lib/canonicalKb";
import { sanitizeKnowledgeItem } from "../lib/agentTools";
import {
  classifyOfferUpload,
  OFFER_EXTRACT_INSTRUCTIONS,
  parseOfferLlmJson,
  parseOptionalIsoDate,
  pdfBufferToText,
  spreadsheetBufferToText,
} from "../lib/offerIngest";

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

function endOfNextIstDay(): Date {
  const ist = new Date(Date.now() + 5.5 * 3600_000);
  const end = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 1, 18, 29, 59, 0); // 23:59:59 IST
  return new Date(end);
}

function parseOptionalDate(v: unknown): Date | null {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

// ─── Daily stock upload: wipes old stock rows then ingests fresh Excel ────────
// Expected columns: Model | SKU | SKU Description | SKU wise Inventory Qty
router.post("/knowledge/upload/stock", upload.single("file"), async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  if (!req.file) { res.status(400).json({ error: "file required" }); return; }
  const stockFileName = req.file.originalname;
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
      effectiveFrom: new Date(),
      effectiveUntil: endOfNextIstDay(),
      source: `stock-upload:${stockFileName}`,
    }));
    if (inserts.length === 0) {
      res.status(400).json({ error: "no valid stock rows found — refusing to wipe existing KB" });
      return;
    }
    // Atomic: only delete existing once we have valid rows to insert
    await db.transaction(async (tx) => {
      await tx.delete(knowledgeTable).where(eq(knowledgeTable.category, "stock"));
      invalidateKnowledgeCache();
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
  const priceFileName = req.file.originalname;
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
      effectiveFrom: new Date(),
      source: `price-upload:${priceFileName}`,
    }));
    if (inserts.length === 0) {
      res.status(400).json({ error: "no valid price rows found — refusing to wipe existing KB" });
      return;
    }
    await db.transaction(async (tx) => {
      await tx.delete(knowledgeTable).where(eq(knowledgeTable.category, "price"));
      invalidateKnowledgeCache();
      await tx.insert(knowledgeTable).values(inserts);
    });
    res.json({ ok: true, models: inserts.length, source: req.file.originalname });
  } catch (err) {
    res.status(500).json({ error: String((err as Error).message) });
  }
});

// ─── Offer upload: image / PDF / Excel → structured KB offer rows ─────────────
async function ingestOfferUpload(req: import("express").Request, res: import("express").Response): Promise<void> {
  if (!requireAdmin(req, res)) return;
  if (!req.file) { res.status(400).json({ error: "file required (image, PDF, or Excel)" }); return; }
  const mime = (req.file.mimetype || "").toLowerCase();
  const kind = classifyOfferUpload(req.file.originalname, mime);
  if (!kind) {
    res.status(400).json({ error: `unsupported file type "${mime || req.file.originalname}" — upload JPG/PNG/WebP, PDF, or Excel/CSV` });
    return;
  }

  try {
    const { default: OpenAI } = await import("openai");
    const openai = new OpenAI({
      apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
      baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
    });

    type ContentPart =
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
      | { type: "file"; file: { filename: string; file_data: string } };
    let userContent: ContentPart[];
    let model = "gpt-4o";

    if (kind === "image") {
      const dataUrl = `data:${mime || "image/jpeg"};base64,${req.file.buffer.toString("base64")}`;
      userContent = [
        { type: "text", text: OFFER_EXTRACT_INSTRUCTIONS },
        { type: "image_url", image_url: { url: dataUrl } },
      ];
    } else if (kind === "pdf") {
      const text = await pdfBufferToText(req.file.buffer);
      if (text.length >= 80) {
        model = "gpt-4o-mini";
        userContent = [{ type: "text", text: `${OFFER_EXTRACT_INSTRUCTIONS}\n\n--- PDF TEXT ---\n${text.slice(0, 18_000)}` }];
      } else {
        // Scanned / image-only PDF: send the file to GPT-4o.
        userContent = [
          { type: "text", text: OFFER_EXTRACT_INSTRUCTIONS },
          {
            type: "file",
            file: {
              filename: req.file.originalname || "offer.pdf",
              file_data: `data:application/pdf;base64,${req.file.buffer.toString("base64")}`,
            },
          },
        ];
      }
    } else {
      const text = spreadsheetBufferToText(req.file.buffer);
      if (text.length < 20) {
        res.status(400).json({ error: "spreadsheet is empty" });
        return;
      }
      model = "gpt-4o-mini";
      userContent = [{ type: "text", text: `${OFFER_EXTRACT_INSTRUCTIONS}\n\n--- SPREADSHEET ---\n${text}` }];
    }

    const completion = await openai.chat.completions.create({
      model,
      messages: [{ role: "user", content: userContent as never }],
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_tokens: 1200,
    });

    const items = parseOfferLlmJson(completion.choices[0]?.message?.content ?? "{}");
    if (items.length === 0) {
      res.status(400).json({ error: "no offer details extracted — try a clearer file" });
      return;
    }

    const inserts = items.map((it) => ({
      title: it.title,
      content: it.content,
      category: "offer" as const,
      modelName: it.modelName ?? null,
      isActive: true,
      source: `offer-upload:${req.file!.originalname}`,
      effectiveFrom: parseOptionalIsoDate(it.validFrom) ?? new Date(),
      effectiveUntil: parseOptionalIsoDate(it.validUntil),
    }));

    await db.insert(knowledgeTable).values(inserts);
    invalidateKnowledgeCache();
    res.json({ ok: true, kind, items: inserts.map((i) => ({ title: i.title, content: i.content })), source: req.file.originalname });
  } catch (err) {
    res.status(500).json({ error: String((err as Error).message) });
  }
}

router.post("/knowledge/upload/offer", upload.single("file"), ingestOfferUpload);
router.post("/knowledge/upload/offer-image", upload.single("file"), ingestOfferUpload);

router.get("/knowledge", async (req, res): Promise<void> => {
  await syncCanonicalKnowledgeOnce();
  const params = ListKnowledgeItemsQueryParams.safeParse(req.query);
  let items = await db.select().from(knowledgeTable).orderBy(knowledgeTable.category);

  // Hide self-learning review-pending items from the main KB list by default.
  // The Pending Review UI uses GET /knowledge/pending explicitly.
  items = items.filter((i) => !i.requiresReview).map(sanitizeKnowledgeItem);

  if (params.success && params.data.category) {
    items = items.filter((i) => i.category === params.data.category);
  }

  res.json(items);
});

// ─── Historical call recording upload → Whisper STT → self-learning queue ─────
// Accepts MP3/WAV/M4A/OGG (and Windows octet-stream with those extensions) up to 25 MB.
// Telecaller recordings use a skill-extract prompt (not a Sakshi-audit) and always
// land in the amber Review queue. Count inserted/queued — never a requires_review delta.
router.post("/knowledge/upload/recording", uploadAudio.single("file"), async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  if (!req.file) { res.status(400).json({ error: "audio file required" }); return; }
  const mime = inferAudioMime(req.file.originalname, req.file.mimetype);
  if (!mime) {
    res.status(400).json({
      error: `unsupported audio type "${req.file.mimetype || "unknown"}" — please upload MP3, WAV, M4A, OGG, or WebM`,
    });
    return;
  }
  try {
    const { default: OpenAI } = await import("openai");
    const { toFile } = await import("openai/uploads");
    const openai = new OpenAI({
      apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
      baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
    });

    const filename = whisperFilename(req.file.originalname, mime);
    const file = await toFile(req.file.buffer, filename, { type: mime });
    const tx = await openai.audio.transcriptions.create({
      file,
      model: "whisper-1",
      language: WHISPER_LANGUAGE,
      prompt: WHISPER_HINT,
    });
    const transcript = (tx.text ?? "").trim();
    if (transcript.length < 20) {
      res.status(400).json({
        error: "Recording was too quiet or Whisper heard almost nothing. Try a clearer MP3 or M4A.",
        transcriptChars: transcript.length,
      });
      return;
    }

    let summary = "Telecaller recording";
    try {
      const analysis = await analyzeCallIntent(transcript);
      summary = analysis.summary ?? summary;
    } catch (err) {
      logger.warn({ err, filename }, "analyzeCallIntent failed on upload; still extracting skills");
    }

    const source = `upload:${req.file.originalname}`;
    const learned = await learnFromTranscript(transcript, summary, {
      source,
      mode: "telecaller_recording",
      forceReview: true,
    });

    res.json({
      ok: true,
      filename: req.file.originalname,
      transcriptChars: transcript.length,
      summary,
      itemsQueuedForReview: learned.queued,
      itemsInserted: learned.inserted,
      itemsExtracted: learned.extracted,
      itemsAutoApplied: learned.autoApplied,
      itemsSkipped: learned.skipped,
    });
  } catch (err) {
    const message = String((err as Error).message);
    const whisperFail = isUnsupportedAudioError(message);
    res.status(whisperFail ? 400 : 500).json({
      error: whisperFail
        ? "OpenAI could not read this file. Convert to MP3 or M4A and try again."
        : message,
    });
  }
});

// ─── Bulk export / import for dev → prod KB sync (admin only) ─────────────────
// SAFE ALLOWLIST: only curated KB fields are exported/imported. Review-queue
// fields (requiresReview, evidence, source) and pending rows are excluded so
// unreviewed call-derived data never propagates between environments. The
// review queue must be approved in each environment independently.
const KB_SAFE_FIELDS = ["id", "title", "category", "content", "modelName", "fileUrl", "isActive", "effectiveFrom", "effectiveUntil", "createdAt", "updatedAt"] as const;
const MAX_IMPORT_ROWS = 5000;

router.get("/knowledge/export", async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  await syncCanonicalKnowledgeOnce();
  const rows = await db.select().from(knowledgeTable)
    .where(eq(knowledgeTable.requiresReview, false));
  const items = rows.map((r) => {
    const cleaned = sanitizeKnowledgeItem(r);
    const out: Record<string, unknown> = {};
    for (const k of KB_SAFE_FIELDS) out[k] = (cleaned as Record<string, unknown>)[k];
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
      effectiveFrom: it.effectiveFrom ? new Date(String(it.effectiveFrom)) : null,
      effectiveUntil: it.effectiveUntil ? new Date(String(it.effectiveUntil)) : null,
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

  invalidateKnowledgeCache();
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

router.post("/knowledge/pending/approve-all", async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const rows = await db.update(knowledgeTable)
    .set({ requiresReview: false, isActive: true })
    .where(eq(knowledgeTable.requiresReview, true))
    .returning({ id: knowledgeTable.id });
  invalidateKnowledgeCache();
  res.json({ ok: true, approved: rows.length });
});

router.post("/knowledge/pending/reject-all", async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const deleted = await db.delete(knowledgeTable)
    .where(eq(knowledgeTable.requiresReview, true))
    .returning({ id: knowledgeTable.id });
  res.json({ ok: true, rejected: deleted.length });
});

// Approve only constrains to requiresReview=true so this endpoint can't be used
// to flip arbitrary KB rows back to active.
router.post("/knowledge/:id/approve", async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "invalid id" }); return; }
  const [item] = await db.update(knowledgeTable)
    .set({ requiresReview: false, isActive: true })
    .where(and(eq(knowledgeTable.id, id), eq(knowledgeTable.requiresReview, true)))
    .returning();
  if (!item) { res.status(404).json({ error: "not found or not pending review" }); return; }
  invalidateKnowledgeCache();
  res.json(item);
});

// Reject only deletes review-pending rows, so this endpoint can't be used to
// nuke production KB entries.
router.post("/knowledge/:id/reject", async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "invalid id" }); return; }
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
    effectiveFrom: parseOptionalDate(body.effectiveFrom),
    effectiveUntil: parseOptionalDate(body.effectiveUntil),
  }).returning();

  invalidateKnowledgeCache();
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
  invalidateKnowledgeCache();
  res.json(item);
});

router.delete("/knowledge/:id", async (req, res): Promise<void> => {
  const params = DeleteKnowledgeItemParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await db.delete(knowledgeTable).where(eq(knowledgeTable.id, params.data.id));
  invalidateKnowledgeCache();
  res.sendStatus(204);
});

export default router;
