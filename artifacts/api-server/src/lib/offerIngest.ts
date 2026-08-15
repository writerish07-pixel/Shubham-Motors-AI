import XLSX from "xlsx";

export type OfferKind = "image" | "pdf" | "spreadsheet";

export type ExtractedOffer = {
  title: string;
  content: string;
  modelName?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
};

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp)$/i;
const PDF_EXT = /\.pdf$/i;
const SHEET_EXT = /\.(xlsx|xls|csv)$/i;

export function classifyOfferUpload(filename: string, mime = ""): OfferKind | null {
  const m = mime.toLowerCase();
  const name = filename.toLowerCase();
  if (m.startsWith("image/") || IMAGE_EXT.test(name)) return "image";
  if (m === "application/pdf" || PDF_EXT.test(name)) return "pdf";
  if (
    m.includes("spreadsheet") ||
    m.includes("excel") ||
    m === "text/csv" ||
    m === "application/vnd.ms-excel" ||
    SHEET_EXT.test(name)
  ) return "spreadsheet";
  return null;
}

export function spreadsheetBufferToText(buf: Buffer): string {
  const wb = XLSX.read(buf, { type: "buffer" });
  const chunks: string[] = [];
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    if (csv.trim()) chunks.push(`Sheet: ${sheetName}\n${csv.trim()}`);
  }
  return chunks.join("\n\n").slice(0, 20_000);
}

export function parseOfferLlmJson(raw: string): ExtractedOffer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || "{}");
  } catch {
    return [];
  }
  const obj = parsed as { items?: unknown[] };
  const items = Array.isArray(obj.items) ? obj.items : [];
  const out: ExtractedOffer[] = [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const rec = it as Record<string, unknown>;
    const title = String(rec.title ?? "").trim();
    const content = String(rec.content ?? "").trim();
    if (!title || !content) continue;
    out.push({
      title: title.slice(0, 120),
      content: content.slice(0, 2500),
      modelName: rec.modelName ? String(rec.modelName).slice(0, 80) : null,
      validFrom: rec.validFrom ? String(rec.validFrom).slice(0, 32) : null,
      validUntil: rec.validUntil ? String(rec.validUntil).slice(0, 32) : null,
    });
  }
  return out;
}

export function parseOptionalIsoDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const OFFER_EXTRACT_INSTRUCTIONS =
  `You are reading a Hero MotoCorp dealer offer (flyer, PDF scheme, Excel of discounts/EMI/festival promo). ` +
  `Extract every actionable offer and return JSON:\n` +
  `{\n` +
  `  "items": [\n` +
  `    {\n` +
  `      "title": "<short — e.g. 'HDFC weekend cashback (Aug 2026)'>",\n` +
  `      "content": "<COMPLETE: every rupee, %, bank/card, eligible models, min txn, tenure, validity dates. If a % is given, also state rupees on at least one Hero example (e.g. Splendor).>",\n` +
  `      "modelName": "<family or null if all models>",\n` +
  `      "validFrom": "<YYYY-MM-DD or null>",\n` +
  `      "validUntil": "<YYYY-MM-DD or null>"\n` +
  `    }\n` +
  `  ]\n` +
  `}\n` +
  `Multiple distinct offers → multiple items. If this is not a Hero dealer offer, return {"items":[]}.`;

export async function pdfBufferToText(buf: Buffer): Promise<string> {
  const mod = await import("pdf-parse");
  const fn = ((mod as { default?: unknown }).default ?? mod) as (b: Buffer) => Promise<{ text?: string }>;
  const data = await fn(buf);
  return String(data?.text ?? "").replace(/\s+/g, " ").trim();
}
