import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyOfferUpload,
  parseOfferLlmJson,
  parseOptionalIsoDate,
  spreadsheetBufferToText,
} from "../src/lib/offerIngest";
import XLSX from "xlsx";

test("classifyOfferUpload maps image, pdf, excel", () => {
  assert.equal(classifyOfferUpload("flyer.jpg", "image/jpeg"), "image");
  assert.equal(classifyOfferUpload("scheme.PDF", "application/pdf"), "pdf");
  assert.equal(classifyOfferUpload("offers.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), "spreadsheet");
  assert.equal(classifyOfferUpload("list.csv", "text/csv"), "spreadsheet");
  assert.equal(classifyOfferUpload("notes.txt", "text/plain"), null);
});

test("spreadsheetBufferToText includes sheet headers and rupee cells", () => {
  const wb = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ["Model", "Offer", "Valid till"],
    ["Splendor XTEC", "₹3000 exchange", "2026-08-31"],
  ]);
  XLSX.utils.book_append_sheet(wb, sheet, "Offers");
  const buf = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
  const text = spreadsheetBufferToText(buf);
  assert.match(text, /Splendor XTEC/);
  assert.match(text, /3000/);
});

test("parseOfferLlmJson keeps validity dates", () => {
  const items = parseOfferLlmJson(JSON.stringify({
    items: [
      { title: "HDFC cashback", content: "5% up to ₹2000 on Splendor", modelName: "Splendor", validFrom: "2026-08-01", validUntil: "2026-08-31" },
      { title: "", content: "skip" },
    ],
  }));
  assert.equal(items.length, 1);
  assert.equal(items[0]!.title, "HDFC cashback");
  assert.equal(items[0]!.validUntil, "2026-08-31");
  const d = parseOptionalIsoDate("2026-08-31");
  assert.ok(d && d.getUTCFullYear() === 2026);
});
