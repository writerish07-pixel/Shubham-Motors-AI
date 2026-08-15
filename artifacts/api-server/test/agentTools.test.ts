import { test } from "node:test";
import assert from "node:assert/strict";
import {
  exceedsFrequencyCap,
  familiesMentioned,
  formatKnowledgeSlice,
  getReplacementMode,
  isBackchannel,
  isKnowledgeInEffect,
  ncprBlocksOutbound,
  outboundDialingAllowed,
  parseAndStripTags,
  retrieveKnowledgeForUtterance,
  scoreCallShadow,
  whatsappTemplatesOnly,
} from "../src/lib/agentTools";

test("haan/achha/ji are backchannels; real questions are not", () => {
  assert.equal(isBackchannel("haan"), true);
  assert.equal(isBackchannel("Haan ji"), true);
  assert.equal(isBackchannel("achha"), true);
  assert.equal(isBackchannel("जी"), true);
  assert.equal(isBackchannel("ok"), true);
  assert.equal(isBackchannel("hmm"), true);
  assert.equal(isBackchannel("haan splendor dekhna hai"), false);
  assert.equal(isBackchannel("emi kitna hoga"), false);
  assert.equal(isBackchannel(""), true);
});

test("parseAndStripTags extracts EMI/VISIT/TRANSFER and leaves spoken text", () => {
  const { spoken, tags } = parseAndStripTags(
    "Splendor XTEC on-road bataati hoon. [EMI:Splendor XTEC|25000|24] [VISIT] [TRANSFER:FINANCE]",
  );
  assert.match(spoken, /Splendor XTEC/);
  assert.equal(spoken.includes("["), false);
  assert.deepEqual(
    tags.map((t) => t.kind),
    ["EMI", "VISIT", "TRANSFER"],
  );
  assert.equal(tags[0]!.arg, "Splendor XTEC|25000|24");
  assert.equal(tags[2]!.arg, "FINANCE");
});

test("retrieveKnowledgeForUtterance keeps playbooks/offers and 1–2 families", () => {
  const items = [
    { category: "playbook", title: "Test ride close", content: "Ask for a slot today." },
    { category: "offer", title: "May exchange", content: "Exchange bonus 10k" },
    { category: "model", title: "Splendor XTEC", content: "80 kmpl", modelName: "Splendor XTEC" },
    { category: "model", title: "Glamour X DRS", content: "cruise no", modelName: "Glamour X DRS" },
    { category: "model", title: "Xoom 125 ZX", content: "sporty scooter", modelName: "Xoom 125 ZX" },
    { category: "stock", title: "Splendor XTEC", content: "Total in stock: 4" },
    { category: "stock", title: "Xoom 125 ZX", content: "Total in stock: 1" },
  ];
  const sliced = retrieveKnowledgeForUtterance("splendor ki emi kitni hogi", items);
  const titles = sliced.map((i) => i.title);
  assert.ok(titles.includes("Test ride close"));
  assert.ok(titles.includes("May exchange"));
  assert.ok(titles.includes("Splendor XTEC"));
  assert.equal(titles.includes("Xoom 125 ZX"), false);
  assert.ok(familiesMentioned("glamour cruise control").includes("Glamour X"));
});

test("dated KB rows expire", () => {
  const now = new Date("2026-08-15T12:00:00Z");
  assert.equal(isKnowledgeInEffect({ effectiveUntil: new Date("2026-08-14T00:00:00Z") }, now), false);
  assert.equal(isKnowledgeInEffect({ effectiveFrom: new Date("2026-08-16T00:00:00Z") }, now), false);
  assert.equal(isKnowledgeInEffect({ effectiveFrom: new Date("2026-08-01T00:00:00Z") }, now), true);
});

test("stock question without a family returns the daily sheet plus playbooks", () => {
  const items = [
    { category: "playbook", title: "p", content: "x" },
    { category: "stock", title: "A", content: "1" },
    { category: "stock", title: "B", content: "2" },
    { category: "model", title: "Splendor XTEC", content: "80 kmpl" },
  ];
  const sliced = retrieveKnowledgeForUtterance("stock mein kya available hai", items);
  assert.equal(sliced.filter((i) => i.category === "stock").length, 2);
  assert.equal(sliced.some((i) => i.category === "model"), false);
  assert.equal(formatKnowledgeSlice(sliced).includes("[STOCK]"), true);
});

test("replacement mode and NCPR / frequency gates", () => {
  assert.equal(outboundDialingAllowed("full"), true);
  assert.equal(outboundDialingAllowed("inbound"), false);
  assert.equal(outboundDialingAllowed("shadow"), false);
  assert.equal(getReplacementMode({ REPLACEMENT_MODE: "inbound" }), "inbound");
  assert.equal(ncprBlocksOutbound("registered"), true);
  assert.equal(ncprBlocksOutbound("unknown", false), false);
  assert.equal(ncprBlocksOutbound("unknown", true), true);
  assert.equal(ncprBlocksOutbound("clear", true), false);
  assert.equal(exceedsFrequencyCap(2, 2), true);
  assert.equal(exceedsFrequencyCap(1, 2), false);
  assert.equal(whatsappTemplatesOnly({ WHATSAPP_TEMPLATES_ONLY: "1" }), true);
});

test("shadow scorecard rewards visit + punishes filler monologues", () => {
  const weak = scoreCallShadow(
    "Customer: haan\nAgent: achha ji bilkul achha ji Splendor ke baare mein bahut lambi baat",
  );
  const strong = scoreCallShadow(
    "Customer: Splendor XTEC on-road aur EMI chahiye, test ride bhi\nAgent: On-road ₹95,377, 24 month EMI table se. Slot book kar deti hoon.\nCustomer: kal 11 baje\nAgent: Test ride booked.",
    { visitBooked: true },
  );
  assert.ok(strong.overall > weak.overall);
  assert.equal(strong.booking, 100);
  assert.ok(weak.fillerPenalty > 0);
});
