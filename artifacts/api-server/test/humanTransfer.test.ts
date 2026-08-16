import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bargeEnergyHits,
  extractDialWhomNumber,
  formatAnsweredTransfer,
  formatQueuedTransfer,
  isCustomerAskingForHuman,
  isAgentPromisingTransfer,
  matchContactByPhone,
  normalizeAgentPhone,
  peekHumanTransfer,
  queueHumanTransfer,
  queueHumanTransferTeam,
  resetHumanTransferStateForTests,
  resolveConnectNumbers,
  resolveTransferredToLabel,
  takeHumanTransfer,
} from "../src/lib/humanTransfer";
import { tryDirectAnswer } from "../src/lib/modelRouter";
import { prepareTtsText } from "../src/lib/ttsPrep";

test("isCustomerAskingForHuman: Hindi handoff, not EMI questions", () => {
  assert.equal(isCustomerAskingForHuman("kisi se baat karao"), true);
  assert.equal(isCustomerAskingForHuman("agent se baat karni hai"), true);
  assert.equal(isCustomerAskingForHuman("insaan se baat karao"), true);
  assert.equal(isCustomerAskingForHuman("transfer karo"), true);
  assert.equal(isCustomerAskingForHuman("emi kitni hogi 24 month"), false);
  assert.equal(isCustomerAskingForHuman("finance ke baare mein batao"), false);
});

test("isCustomerAskingForHuman: live Devanagari एजेंट requests (calls 15–16)", () => {
  assert.equal(isCustomerAskingForHuman("आप अपने मुझे एजेंट से बात कराओ।"), true);
  assert.equal(isCustomerAskingForHuman("मैं अभी सोच रहा हूँ लेने के लिए, बट आप अपने एक बार के लिए अपने एजेंट से बात करा सकते हो?"), true);
  assert.equal(isCustomerAskingForHuman("अ आप एक बार अपने एजेंट से बात करा सकते हो"), true);
});

test("isAgentPromisingTransfer: verbal handoff without [TRANSFER] tag", () => {
  assert.equal(
    isAgentPromisingTransfer("एक पल दीजिए, मैं आपको अपने एजेंट से बात करवा देती हूँ। धन्यवाद!"),
    true,
  );
  assert.equal(isAgentPromisingTransfer("शिवाय जी। मैं आपको एक पल में अपने एजेंट से बात करवा देती हूँ।"), true);
  assert.equal(isAgentPromisingTransfer("ग्लैमर एक्स डी आर एस में क्रूज़ कंट्रोल नहीं है।"), false);
});

test("queueHumanTransfer normalises 10-digit mobile", () => {
  resetHumanTransferStateForTests();
  assert.equal(normalizeAgentPhone("9876543210"), "+919876543210");
  assert.equal(queueHumanTransfer("CA1", "9876543210", "Ramesh"), true);
  assert.equal(takeHumanTransfer("CA1")?.phone, "+919876543210");
  assert.equal(takeHumanTransfer("CA1"), undefined);
});

test("team queue rings every salesperson and peek does not consume", () => {
  resetHumanTransferStateForTests();
  assert.equal(queueHumanTransferTeam("CA-TEAM", [
    { phone: "9876543210", name: "Rahul" },
    { phone: "0 9123456789", name: "Amit" },
    { phone: "9876543210", name: "Rahul dup" },
  ]), true);
  const peeked = peekHumanTransfer("CA-TEAM");
  assert.deepEqual(peeked?.phones, ["+919876543210", "+919123456789"]);
  assert.equal(peekHumanTransfer("CA-TEAM")?.phones.length, 2);

  const numbers = resolveConnectNumbers({
    callSid: "CA-TEAM",
    contacts: [],
    strategy: "simultaneous",
  });
  assert.deepEqual(numbers, ["+919876543210", "+919123456789"]);
  assert.equal(peekHumanTransfer("CA-TEAM")?.label, "Rahul, Amit, Rahul dup");
});

test("connect falls back to all active CRM sales contacts", () => {
  resetHumanTransferStateForTests();
  const numbers = resolveConnectNumbers({
    callSid: "unknown",
    contacts: [
      { type: "sales", isActive: true, phone: "9000000001", name: "A" },
      { type: "sales", isActive: false, phone: "9000000002", name: "B" },
      { type: "finance", isActive: true, phone: "9000000003", name: "C" },
      { type: "sales", isActive: true, phone: "9000000004", name: "D" },
    ],
    fallback: "9111111111",
    strategy: "simultaneous",
  });
  assert.deepEqual(numbers, ["+919000000001", "+919000000004"]);
});

test("round_robin returns one rotating salesperson", () => {
  resetHumanTransferStateForTests();
  const contacts = [
    { type: "sales", isActive: true, phone: "9000000001", name: "A" },
    { type: "sales", isActive: true, phone: "9000000002", name: "B" },
  ];
  const first = resolveConnectNumbers({ callSid: "rr1", contacts, strategy: "round_robin" });
  const second = resolveConnectNumbers({ callSid: "rr2", contacts, strategy: "round_robin" });
  const third = resolveConnectNumbers({ callSid: "rr3", contacts, strategy: "round_robin" });
  assert.deepEqual(first, ["+919000000001"]);
  assert.deepEqual(second, ["+919000000002"]);
  assert.deepEqual(third, ["+919000000001"]);
});

test("DialWhomNumber matches CRM contact for transferred_to", () => {
  const contacts = [
    { name: "Rahul Sharma", phone: "9876543210" },
    { name: "Amit", phone: "+919123456789" },
  ];
  assert.equal(extractDialWhomNumber({ DialWhomNumber: "09876543210" }), "09876543210");
  assert.equal(matchContactByPhone("09876543210", contacts)?.name, "Rahul Sharma");
  assert.equal(
    resolveTransferredToLabel({ DialWhomNumber: "09123456789" }, contacts),
    "Amit +919123456789",
  );
  assert.equal(
    resolveTransferredToLabel({ "Legs[0][Number]": "9876543210" }, contacts),
    formatAnsweredTransfer("Rahul Sharma", "9876543210"),
  );
  assert.equal(formatQueuedTransfer([
    { phone: "+919876543210", name: "Rahul" },
    { phone: "+919123456789", name: "Amit" },
  ]), "queued: Rahul, Amit");
});

test("bargeEnergyHits: loud speech beats echo floor", () => {
  assert.equal(bargeEnergyHits(0.08, 0.02, 0.024), true);
  assert.equal(bargeEnergyHits(0.02, 0.02, 0.024), false);
});

test("tryDirectAnswer: Glamour cruise is spoken Hindi, not Latin IVR", () => {
  const reply = tryDirectAnswer("isme cruise control aata hai kya", "", "जी", {
    signals: { interestedModel: "Glamour X" },
    history: [{ role: "assistant", content: "ग्लैमर एक्स" }],
  });
  assert.ok(reply);
  assert.match(reply, /क्रूज़ कंट्रोल/);
  assert.doesNotMatch(reply, /variant mein cruise control hai/);
});

test("prepareTtsText keeps a cruise line in Hindi accent", () => {
  const spoken = prepareTtsText(
    "Glamour X DSS variant mein cruise control hai — DRS variant mein nahi hota. Highway ride comfortable rehti hai.",
  );
  assert.match(spoken, /ग्लैमर/);
  assert.match(spoken, /क्रूज़ कंट्रोल|क्रूज़/);
  assert.doesNotMatch(spoken, /comfortable|highway ride/i);
});

test("prepareTtsText: old Latin proactive line is spoken as Hindi", () => {
  const spoken = prepareTtsText(
    "aap sun pa rahe hain? Main Shubham Motors se Sakshi bol rahi hoon — koi bhi Hero bike ya scooter ke baare mein batayein.",
  );
  assert.doesNotMatch(spoken, /aap sun pa rahe hain/i);
  assert.match(spoken, /सुन|बाइक|स्कूटर|साक्षी|शुभम/);
});
