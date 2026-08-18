/**
 * Persistence after the call: never abandon a maybe; never violate DND;
 * never invent a co-dealer discount.
 */

export const MISSED_VISIT_REASON = "Missed test ride — same-evening rebook";
export const RELATIONSHIP_DOOR_REASON = "Bought elsewhere — service or second vehicle";

const VISIT_GRACE_MS = 90 * 60_000;
const VISIT_CHASE_WINDOW_MS = 48 * 3600_000;
const RELATIONSHIP_DOOR_DAYS = 21;

export function isMissedVisitReason(reason?: string | null): boolean {
  return /missed test ride/i.test(String(reason ?? ""));
}

export function isRelationshipDoorReason(reason?: string | null): boolean {
  return /bought elsewhere|service or second vehicle/i.test(String(reason ?? ""));
}

/** Autodialer may still ring a lost lead only for the relationship-door follow-up. */
export function skipOutboundForLeadStatus(status: string | null | undefined, reason?: string | null): boolean {
  const s = String(status ?? "");
  if (s === "converted" || s === "wrong_number" || s === "not_interested") return true;
  if (s === "lost") return !isRelationshipDoorReason(reason);
  return false;
}

export function isHardCallOptOut(text: string): boolean {
  return /(?:mat\s+(?:karo|karna|kijiye)\s*(?:call|phone)|call\s+mat\s+(?:karo|karna|kijiye)|band\s+karo\s+call|call\s+band\s+karo|hata\s*(?:lo|do)\s+number|number\s+hata\s*(?:lo|do)|do\s+not\s+call|don'?t\s+call|stop\s+calling|\bdnd\b|block\s+(?:karo|kar\s+do)|मत\s+करो\s+(?:कॉल|फोन)|कॉल\s+मत\s+करो|बंद\s+करो\s+कॉल|हटा\s+लो\s+नंबर)/i.test(
    text,
  );
}

export function isConfirmedPurchaseElsewhere(text: string): boolean {
  return /already (?:bought|booked|purchased)|ले ली|खरीद ली|ले लिया|book kar diya|dusre (?:dealer|brand).*(?:le li|le liya)|Honda se le li|TVS se le li|Bajaj se le li/i.test(
    text,
  );
}

export function isSoftRejection(text: string): boolean {
  if (isHardCallOptOut(text) || isConfirmedPurchaseElsewhere(text)) return false;
  return /नहीं चाहिए|नही चाहिए|nahi chahiye|nahi chaiye|don't want|dont want|interest nahi|interested nahi|मत लो|zaroorat nahi|जरूरत नहीं|नहीं लेना|nahi lena/i.test(
    text,
  );
}

export function isCoDealerPriceFight(text: string): boolean {
  if (isConfirmedPurchaseElsewhere(text)) return false;
  return /(?:dusre|दूसरे|दूसरा|other|koi aur)\s*(?:dealer|डीलर)|co[- ]?dealer|बापू नगर|sasti.*dealer|dealer.*sasti|kam de rahe|कम दे रहे/i.test(
    text,
  );
}

/** Exact rupee cash match — Sakshi cannot invent this; Priyanka must take the line. */
export function isAskingExactDiscount(text: string): boolean {
  if (isHardCallOptOut(text)) return false;
  return /(?:बेस्ट\s*)?(?:डिस्काउंट|discount)\s*(?:क्या|कितना|दे\s*सकते|दो)|best discount|exact discount|कैश\s*(?:में\s*)?(?:डिस्काउंट|discount)|cash discount|कितना\s*(?:डिस्काउंट|discount)|₹\s*\d[\d,]*\s*(?:का\s*)?(?:डिस्काउंट|discount)/i.test(
    text,
  );
}

/** Cheap at another shop is a transfer, not a lost deal. Confirmed purchase is lost. */
export function coerceLostDeal(transcript: string, llmLostDeal: boolean): boolean {
  if (isHardCallOptOut(transcript)) return false;
  if (isConfirmedPurchaseElsewhere(transcript)) return true;
  if (isCoDealerPriceFight(transcript)) return false;
  return llmLostDeal;
}

export function lostElsewhereFollowUp(): string {
  return "किस ब्रांड या डीलर से ली, और क्या ऑफ़र मिला? सर्विस या दूसरी गाड़ी लगे तो हम यहीं हैं।";
}

export function coDealerPriceFollowUp(): string {
  return "एक्सचेंज और फाइनेंस यहाँ क्लियर कर सकते हैं। जो exact कैश कम है वो सेल्स लाइन पर बताएगी — जोड़ दूँ?";
}

export function relationshipDoorAt(now = new Date(), days = RELATIONSHIP_DOOR_DAYS): Date {
  return new Date(now.getTime() + days * 86400000);
}

export function relationshipDoorFollowUp(now = new Date()): { scheduledAt: Date; reason: string } {
  return { scheduledAt: relationshipDoorAt(now), reason: RELATIONSHIP_DOOR_REASON };
}

/** Next dial time after a booked visit was missed. Null = too soon or too late to chase. */
export function nextMissedVisitDialAt(
  visitScheduledAt: Date,
  now = new Date(),
  hourIst?: number,
): Date | null {
  const elapsed = now.getTime() - visitScheduledAt.getTime();
  if (elapsed < VISIT_GRACE_MS) return null;
  if (elapsed > VISIT_CHASE_WINDOW_MS) return null;
  const h = hourIst ?? hourIstFrom(now);
  return nextCallableInstant(now, h);
}

export function nextCallableInstant(now: Date, hourIst: number): Date {
  if (hourIst >= 9 && hourIst < 13) return now;
  if (hourIst >= 14 && hourIst < 20) return now;
  if (hourIst === 13) return new Date(now.getTime() + 60 * 60_000);
  if (hourIst < 9) return new Date(now.getTime() + (9 - hourIst) * 3600_000);
  return new Date(now.getTime() + (24 - hourIst + 10) * 3600_000);
}

function hourIstFrom(now: Date): number {
  return new Date(now.getTime() + 5.5 * 3600_000).getUTCHours();
}

/**
 * Soft "नहीं चाहिए" is a stall, not a dead lead — unless they opted out.
 * Bought-elsewhere stays a lost *status* in CRM; intent becomes thinking so
 * the 21-day relationship door can still be scheduled.
 */
export function persistAsThinkingIfSoftNo(
  intent: string,
  transcript: string,
  _lostDeal = false,
): string {
  if (isHardCallOptOut(transcript)) return "not_interested";
  if (intent === "wrong_number") return intent;
  if (intent === "not_interested") return "thinking";
  if (isSoftRejection(transcript) && (intent === "needs_info" || intent === "hot_buy")) return "thinking";
  return intent;
}

/** Keep a remapped soft-no in the 7-day nurture band instead of a 0–20 dead score. */
export function softenSoftNoScore(intent: string, originalIntent: string, score: number): number {
  if (originalIntent === "not_interested" && intent === "thinking") return Math.max(score, 42);
  return score;
}
