/**
 * Relationship & Revenue Intelligence engine (Growth OS v2).
 *
 * Turns the per-call analysis + discovery signals + call history into the
 * scores that move Shubham Motors from a *lead* CRM to a *relationship* CRM:
 *   • Purchase stage     (PRD Phase 4 — Purchase Intelligence)
 *   • Customer persona   (PRD Phase 11 — Marketing Intelligence)
 *   • Relationship scores (PRD Phase 3 — Relationship Intelligence)
 *   • Purchase probability (PRD Phase 5 — Sales Intelligence)
 *   • Expected revenue + lifetime value (PRD Phase 13 — Revenue Engine)
 *
 * This module is intentionally PURE and DETERMINISTIC: no DB, no network, no
 * LLM, no clock. Given the same input it always returns the same patch, so it
 * is cheap to call after every call and trivial to unit-test. callFinalize.ts
 * feeds it data it has already computed — there is no extra API cost.
 */

export type PurchaseStage =
  | "exploration"
  | "comparison"
  | "evaluation"
  | "ready"
  | "negotiation"
  | "booked"
  | "delivered"
  | "repeat";

export type CustomerPersona =
  | "price_sensitive"
  | "mileage_sensitive"
  | "technology_sensitive"
  | "status_sensitive"
  | "family_buyer"
  | "business_buyer"
  | "performance_buyer"
  | "value_buyer"
  | "comfort_buyer"
  | "safety_buyer";

export interface IntelligenceInput {
  /** analyzeCallIntent intent label: hot_buy | interested | thinking | future_date | not_interested | wrong_number | needs_info */
  intent: string;
  /** analyzeCallIntent buying-intent score, 0–100 */
  callScore: number;
  objections?: string[];
  competitorMentioned?: string | null;
  /** immediate | 15days | month | festival | loan_closure | next_year */
  buyingTimeline?: string | null;
  decisionMaker?: "self" | "family" | "joint" | null;
  visitPlanned?: boolean;
  lostDeal?: boolean;

  // ── discovery signals ──
  segment?: string | null;
  stylePreference?: "sporty" | "family" | "commuter" | null;
  budget?: number | null;
  dailyKm?: number | null;
  financeInterest?: boolean;
  exchangeInterest?: boolean;
  comparingBrands?: boolean;
  readyToBuy?: boolean;
  negotiating?: boolean;
  familyUse?: boolean;
  /** office | college | business | family */
  purpose?: string | null;
  currentVehicle?: string | null;
  interestedModel?: string | null;

  // ── history / prior state ──
  /** Total completed calls with this lead, including the one just finished. */
  completedCalls?: number;
  /** Prior lead.status before this call (new|contacted|interested|hot|converted|lost|…). */
  priorStatus?: string | null;
  /** Resolved on-road price of the model of interest, ₹. Falls back to a
   *  segment-based estimate when not supplied. */
  vehiclePrice?: number | null;
}

export interface LeadIntelligencePatch {
  purchaseStage: PurchaseStage;
  customerPersona: CustomerPersona;
  relationshipScore: number;
  trustScore: number;
  engagementScore: number;
  loyaltyScore: number;
  followupScore: number;
  purchaseProbability: number;
  expectedRevenue: number;
  lifetimeValue: number;
}

const clamp = (n: number, lo = 0, hi = 100): number =>
  Math.max(lo, Math.min(hi, Math.round(n)));

// Hero-owned models (used for loyalty / repeat detection). Honda Activa, TVS
// Jupiter etc. are deliberately NOT here — those are competitor conquests.
const HERO_MODEL_TOKENS = [
  "splendor", "passion", "glamour", "xtreme", "xpulse", "hf",
  "destini", "pleasure", "maestro", "xoom", "karizma", "super splendor",
];

function ownsHero(currentVehicle?: string | null): boolean {
  if (!currentVehicle) return false;
  const v = currentVehicle.toLowerCase();
  return HERO_MODEL_TOKENS.some((m) => v.includes(m));
}

function mentionsPrice(objections?: string[]): boolean {
  if (!objections?.length) return false;
  return objections.some((o) =>
    /price|cost|discount|expensive|mehang|daam|kimat|offer|emi/i.test(o),
  );
}

/** Typical on-road price in ₹ by segment — only used when the exact model
 *  price is unknown, so revenue numbers stay sensible rather than zero. */
const SEGMENT_PRICE: Record<string, number> = {
  "100cc": 85000,
  "125cc": 100000,
  "160cc+": 140000,
  scooter_110: 90000,
  scooter_125: 100000,
  electric: 130000,
};
const DEFAULT_VEHICLE_PRICE = 95000;

function resolveVehiclePrice(input: IntelligenceInput): number {
  if (input.vehiclePrice && input.vehiclePrice > 0) return input.vehiclePrice;
  if (input.segment && SEGMENT_PRICE[input.segment]) return SEGMENT_PRICE[input.segment];
  return DEFAULT_VEHICLE_PRICE;
}

// ─── Purchase stage (PRD Phase 4) ─────────────────────────────────────────────
// Pick the most advanced stage the call evidences. Ranked so a strong signal
// (negotiation) always wins over a weaker co-occurring one (comparison).
export function derivePurchaseStage(input: IntelligenceInput): PurchaseStage {
  if (input.priorStatus === "converted" || input.priorStatus === "delivered") {
    // A converted owner talking to us again is a repeat-purchase opportunity.
    return "repeat";
  }

  const candidates: Array<[PurchaseStage, boolean]> = [
    ["negotiation", Boolean(input.negotiating) || (input.readyToBuy === true && mentionsPrice(input.objections))],
    ["ready", input.intent === "hot_buy" || input.readyToBuy === true || input.buyingTimeline === "immediate"],
    ["evaluation", Boolean(input.visitPlanned || input.financeInterest || input.exchangeInterest)],
    ["comparison", Boolean(input.comparingBrands || input.competitorMentioned)],
    ["exploration", true], // base case — always matches
  ];

  // candidates are ordered most→least advanced; first truthy wins.
  for (const [stage, matched] of candidates) {
    if (matched) return stage;
  }
  return "exploration";
}

// ─── Customer persona (PRD Phase 11) ─────────────────────────────────────────
// First match wins — ordered by how decisive the signal is for sales strategy.
export function inferCustomerPersona(input: IntelligenceInput): CustomerPersona {
  if (input.purpose === "business") return "business_buyer";
  if (input.familyUse || input.stylePreference === "family" || input.decisionMaker === "family") {
    return "family_buyer";
  }
  if (input.stylePreference === "sporty" || input.segment === "160cc+") return "performance_buyer";
  if (input.negotiating || mentionsPrice(input.objections) || (input.budget != null && input.budget > 0 && input.budget < 70000)) {
    return "price_sensitive";
  }
  if (input.dailyKm != null && input.dailyKm >= 40) return "mileage_sensitive";
  if (input.budget != null && input.budget >= 150000) return "status_sensitive";
  if (input.segment === "scooter_110" || input.segment === "scooter_125") return "comfort_buyer";
  if (input.financeInterest) return "value_buyer";
  return "value_buyer";
}

// ─── Relationship scores (PRD Phase 3) ───────────────────────────────────────
export function computeRelationshipScores(input: IntelligenceInput): {
  trustScore: number;
  engagementScore: number;
  loyaltyScore: number;
  followupScore: number;
  relationshipScore: number;
} {
  const calls = Math.max(0, input.completedCalls ?? 1);
  const objectionCount = input.objections?.length ?? 0;
  const heroOwner = ownsHero(input.currentVehicle);
  const interested =
    input.intent === "not_interested" || input.intent === "wrong_number";

  // Engagement — depth of interaction this relationship has had.
  let engagement = 20;
  engagement += Math.min(calls, 5) * 10;
  engagement += input.visitPlanned ? 15 : 0;
  engagement += input.financeInterest || input.exchangeInterest ? 10 : 0;
  engagement += objectionCount > 0 ? 5 : 0; // asking questions = engaged
  const engagementScore = clamp(engagement);

  // Trust — confidence in the dealership; repeated contact and a showroom
  // commitment build it, unresolved objections and competitor shopping erode it.
  let trust = 25;
  trust += Math.min(calls, 4) * 8;
  trust += input.visitPlanned ? 15 : 0;
  trust += heroOwner ? 12 : 0;
  trust -= objectionCount * 4;
  trust -= input.competitorMentioned ? 6 : 0;
  let trustScore = clamp(trust);
  if (input.lostDeal) trustScore = Math.min(trustScore, 20);

  // Loyalty — existing Hero equity and repeat behaviour.
  let loyalty = 10;
  loyalty += heroOwner ? 40 : 0;
  loyalty += input.priorStatus === "converted" ? 30 : 0;
  loyalty += Math.min(calls, 3) * 5;
  const loyaltyScore = clamp(loyalty);

  // Follow-up responsiveness — how reachable/receptive the customer is, which
  // drives how aggressively the auto-dialer should pursue them.
  let followup = 30;
  followup += Math.min(calls, 4) * 12;
  followup += input.buyingTimeline && input.buyingTimeline !== "next_year" ? 15 : 0;
  followup -= interested ? 40 : 0;
  const followupScore = clamp(followup);

  const relationshipScore = clamp(
    0.35 * trustScore + 0.3 * engagementScore + 0.2 * loyaltyScore + 0.15 * followupScore,
  );

  return { trustScore, engagementScore, loyaltyScore, followupScore, relationshipScore };
}

// ─── Purchase probability (PRD Phase 5) ──────────────────────────────────────
export function computePurchaseProbability(input: IntelligenceInput): number {
  if (input.lostDeal) return 0;
  if (input.intent === "wrong_number") return 0;
  if (input.intent === "not_interested") return Math.min(5, clamp(input.callScore));

  let p = clamp(input.callScore); // buying-intent score is the anchor

  switch (input.buyingTimeline) {
    case "immediate": p += 12; break;
    case "15days": p += 8; break;
    case "month": p += 3; break;
    case "festival": p += 0; break;
    case "loan_closure": p -= 5; break;
    case "next_year": p -= 15; break;
  }
  if (input.readyToBuy) p += 8;
  if (input.negotiating) p += 6;
  if (input.visitPlanned) p += 8;
  if (input.competitorMentioned) p -= 5;

  return clamp(p, 0, 98);
}

// ─── Revenue (PRD Phase 13) ──────────────────────────────────────────────────
export function estimateExpectedRevenue(
  input: IntelligenceInput,
  purchaseProbability: number,
): number {
  const price = resolveVehiclePrice(input);
  return Math.round((price * purchaseProbability) / 100);
}

/**
 * Lifetime value across the whole relationship, not just this sale:
 * vehicle + finance margin + 5yr insurance + 5yr service + accessories +
 * referral potential + future-upgrade potential (PRD Phase 6 + 13).
 */
export function estimateLifetimeValue(
  input: IntelligenceInput,
  relationshipScore: number,
  loyaltyScore: number,
): number {
  const price = resolveVehiclePrice(input);
  const finance = input.financeInterest ? 8000 : 4000;
  const insurance = Math.round(price * 0.03 * 5); // ~3% of value/yr over 5 yrs
  const service = 3000 * 5;
  const accessories = 8000;
  const referral = relationshipScore >= 60 ? 50000 : 15000;
  const futureUpgrade = loyaltyScore >= 50 ? 60000 : 20000;
  return Math.round(
    price + finance + insurance + service + accessories + referral + futureUpgrade,
  );
}

// ─── Top-level: one patch for the leads table ────────────────────────────────
export function computeLeadIntelligence(input: IntelligenceInput): LeadIntelligencePatch {
  const purchaseStage = derivePurchaseStage(input);
  const customerPersona = inferCustomerPersona(input);
  const scores = computeRelationshipScores(input);
  const purchaseProbability = computePurchaseProbability(input);
  const expectedRevenue = estimateExpectedRevenue(input, purchaseProbability);
  const lifetimeValue = estimateLifetimeValue(input, scores.relationshipScore, scores.loyaltyScore);

  return {
    purchaseStage,
    customerPersona,
    ...scores,
    purchaseProbability,
    expectedRevenue,
    lifetimeValue,
  };
}
