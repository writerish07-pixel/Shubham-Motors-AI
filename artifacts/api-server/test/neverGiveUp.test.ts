import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RELATIONSHIP_DOOR_REASON,
  coerceLostDeal,
  coDealerPriceFollowUp,
  isCoDealerPriceFight,
  isConfirmedPurchaseElsewhere,
  isHardCallOptOut,
  isMissedVisitReason,
  isRelationshipDoorReason,
  isSoftRejection,
  lostElsewhereFollowUp,
  nextMissedVisitDialAt,
  persistAsThinkingIfSoftNo,
  relationshipDoorFollowUp,
  skipOutboundForLeadStatus,
  softenSoftNoScore,
} from "../src/lib/neverGiveUp";
import { pickContextualFollowUp } from "../src/lib/salesFollowUp";
import { buildPurchaseVerificationGreeting } from "../src/lib/followUpCallContext";
import { detectIntentWithMeta } from "../src/lib/voiceFastPath";

test("DND is hard opt-out; soft नहीं चाहिए is not", () => {
  assert.equal(isHardCallOptOut("call mat karo"), true);
  assert.equal(isHardCallOptOut("कॉल मत करो"), true);
  assert.equal(isHardCallOptOut("नहीं चाहिए"), false);
  assert.equal(isHardCallOptOut("nahi chahiye Super Splendor"), false);
  assert.equal(isSoftRejection("नहीं चाहिए"), true);
  assert.equal(isSoftRejection("call mat karo"), false);
});

test("confirmed purchase elsewhere vs co-dealer cash fight", () => {
  assert.equal(isConfirmedPurchaseElsewhere("Honda se le li"), true);
  assert.equal(isConfirmedPurchaseElsewhere("already bought from another dealer"), true);
  assert.equal(isConfirmedPurchaseElsewhere("dusre dealer kam de rahe"), false);
  assert.equal(isCoDealerPriceFight("dusre dealer kam de rahe hain"), true);
  assert.equal(isCoDealerPriceFight("Honda se le li"), false);
  assert.equal(coerceLostDeal("Honda se le li", false), true);
  assert.equal(coerceLostDeal("dusre dealer sasti de rahe", true), false);
  assert.equal(coerceLostDeal("call mat karo", true), false);
});

test("soft no remaps not_interested to thinking; DND does not", () => {
  assert.equal(persistAsThinkingIfSoftNo("not_interested", "नहीं चाहिए"), "thinking");
  assert.equal(persistAsThinkingIfSoftNo("not_interested", "call mat karo"), "not_interested");
  assert.equal(persistAsThinkingIfSoftNo("not_interested", "Honda se le li", true), "thinking");
  assert.equal(softenSoftNoScore("thinking", "not_interested", 12), 42);
});

test("lost leads skip autodial except the 21-day relationship door", () => {
  assert.equal(skipOutboundForLeadStatus("not_interested"), true);
  assert.equal(skipOutboundForLeadStatus("lost", "Warm lead — 3 day check-in"), true);
  assert.equal(skipOutboundForLeadStatus("lost", RELATIONSHIP_DOOR_REASON), false);
  assert.equal(skipOutboundForLeadStatus("interested", RELATIONSHIP_DOOR_REASON), false);
  assert.equal(isRelationshipDoorReason(RELATIONSHIP_DOOR_REASON), true);
  const door = relationshipDoorFollowUp(new Date("2026-08-17T10:00:00.000Z"));
  assert.equal(door.reason, RELATIONSHIP_DOOR_REASON);
  assert.equal(door.scheduledAt.toISOString(), "2026-09-07T10:00:00.000Z");
});

test("missed visit chase is same evening, not before 90 min, not after 48h", () => {
  const visit = new Date("2026-08-17T04:00:00.000Z");
  assert.equal(nextMissedVisitDialAt(visit, new Date("2026-08-17T05:00:00.000Z"), 10), null);
  const due = nextMissedVisitDialAt(visit, new Date("2026-08-17T06:00:00.000Z"), 15);
  assert.ok(due);
  assert.equal(due!.getTime(), new Date("2026-08-17T06:00:00.000Z").getTime());
  assert.equal(nextMissedVisitDialAt(visit, new Date("2026-08-19T06:00:00.000Z"), 15), null);
  assert.equal(isMissedVisitReason("Missed test ride — same-evening rebook"), true);
});

test("live follow-up: buy-elsewhere stops the pitch; co-dealer offers Priyanka", () => {
  const lost = pickContextualFollowUp({
    signals: { interestedModel: "Super Splendor XTEC" },
    customerText: "Honda se le li Super Splendor",
  });
  assert.equal(lost, lostElsewhereFollowUp());
  assert.doesNotMatch(lost, /टेस्ट राइड|आज शाम/);

  const fight = pickContextualFollowUp({
    signals: { interestedModel: "Super Splendor XTEC" },
    customerText: "dusre dealer Super Splendor ki keemat kam de rahe",
  });
  assert.equal(fight, coDealerPriceFollowUp());
  assert.match(fight, /सेल्स/);
  assert.doesNotMatch(fight, /₹\d/);

  const soft = pickContextualFollowUp({
    signals: { interestedModel: "Super Splendor XTEC" },
    customerText: "नहीं चाहिए",
  });
  assert.match(soft, /बजट|घर|ब्रांड|टेस्ट|वॉट्सऐप/);
  assert.doesNotMatch(soft, /धन्यवाद/);
});

test("missed-visit and relationship-door greetings do not re-pitch the old bike", () => {
  const missed = buildPurchaseVerificationGreeting("मोहन", "Super Splendor", "Missed test ride — same-evening rebook");
  assert.match(missed, /टेस्ट राइड/);
  assert.match(missed, /आज शाम|कल सुबह/);

  const door = buildPurchaseVerificationGreeting("मोहन", "Super Splendor", RELATIONSHIP_DOOR_REASON);
  assert.match(door, /सर्विस|अगली गाड़ी/);
  assert.doesNotMatch(door, /टेस्ट राइड बुक/);
});

test("voice fast-path: DND still goodbyes; नहीं चाहिए does not", () => {
  const dnd = detectIntentWithMeta("call mat karo", 3);
  assert.equal(dnd?.name, "not_interested");
  const soft = detectIntentWithMeta("नहीं चाहिए", 3);
  assert.equal(soft, null);
});
