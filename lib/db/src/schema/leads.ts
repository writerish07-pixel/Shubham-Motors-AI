import { pgTable, text, serial, timestamp, integer, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const leadsTable = pgTable("leads", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  email: text("email"),
  status: text("status").notNull().default("new"),
  score: integer("score").notNull().default(0),
  interestedModel: text("interested_model"),
  language: text("language"),
  notes: text("notes"),
  source: text("source"),
  lastCallId: integer("last_call_id"),
  nextFollowupAt: timestamp("next_followup_at", { withTimezone: true }),
  intentSummary: text("intent_summary"),

  // ── CRM intelligence columns (added June 2026 audit) ──────────────────────
  // Persisted from analyzeCallIntent() after every call. Never ask the customer
  // the same question twice across calls — these carry context forward.

  /** Family members mentioned (e.g. "wife + 2 kids, daughter going to college") */
  familyInfo: text("family_info"),

  /** Current vehicle the customer owns (e.g. "Activa", "Pulsar 150") */
  currentVehicle: text("current_vehicle"),

  /** Daily commute distance in km — drives mileage model recommendation */
  dailyKm: integer("daily_km"),

  /** Vehicle segment the customer wants — the single most important discovery
   *  signal. Recommendations are scoped to this; persisted so the agent never
   *  re-asks it on a later call. One of: 100cc | 125cc | 160cc+ | scooter_110 |
   *  scooter_125 | electric */
  segment: text("segment"),

  /** Approximate budget discussed in ₹ */
  budget: integer("budget"),

  /** Competitor brand the customer mentioned comparing (Bajaj/TVS/Honda/etc.) */
  competitorMentioned: text("competitor_mentioned"),

  /** Why the customer considered the competitor (price/mileage/design/service) */
  competitorReason: text("competitor_reason"),

  /** Customer's preferred call-back time window — used by auto-dialer */
  preferredCallTime: text("preferred_call_time"), // "morning" | "afternoon" | "evening"

  /** Customer's occupation — used for finance eligibility guidance */
  occupation: text("occupation"),

  /** Timeline for purchase — drives follow-up scheduling */
  buyingTimeline: text("buying_timeline"), // "immediate" | "15days" | "month" | "festival" | "loan_closure" | "next_year"

  /** Who makes the purchase decision — self | family | joint */
  decisionMaker: text("decision_maker"),

  /** Lost-deal intelligence (customer bought elsewhere or explicitly chose a competitor) */
  lostToBrand: text("lost_to_brand"),
  lostToDealer: text("lost_to_dealer"),
  lostReason: text("lost_reason"),
  lostOfferFactor: text("lost_offer_factor"),

  /** TRAI/DND compliance — customer explicitly said "don't call me".
   *  Hard gate: the auto-dialer and instant-call trigger must NEVER dial this lead. */
  doNotCall: boolean("do_not_call").notNull().default(false),

  /** Confirmed showroom visit / test ride appointment (from call analysis) */
  visitScheduledAt: timestamp("visit_scheduled_at", { withTimezone: true }),
  /** When the day-of WhatsApp visit reminder was sent — booked-but-no-show killer */
  visitReminderSentAt: timestamp("visit_reminder_sent_at", { withTimezone: true }),

  // ── Relationship & Revenue Intelligence (Growth OS v2, June 2026) ──────────
  // Derived deterministically by lib/relationshipIntel.ts after every call from
  // the existing call analysis + discovery signals + call history. No extra LLM
  // call. All columns are nullable/defaulted so existing leads keep working and
  // the auto-dialer / CRM never break on a missing value.

  /** Where the customer is in the buying journey (Purchase Intelligence, PRD
   *  Phase 4). One of: exploration | comparison | evaluation | ready |
   *  negotiation | booked | delivered | repeat */
  purchaseStage: text("purchase_stage"),

  /** What the customer buys on (Marketing Intelligence, PRD Phase 11). One of:
   *  price_sensitive | mileage_sensitive | technology_sensitive |
   *  status_sensitive | family_buyer | business_buyer | performance_buyer |
   *  value_buyer | comfort_buyer | safety_buyer */
  customerPersona: text("customer_persona"),

  /** 0–100 composite of how strong the dealership relationship is. Drives the
   *  Relationship CRM (PRD Phase 3) — replaces "just a lead" with a tracked
   *  relationship that strengthens or decays over time. */
  relationshipScore: integer("relationship_score").notNull().default(0),
  /** 0–100 — how much the customer trusts the dealership / agent. */
  trustScore: integer("trust_score").notNull().default(0),
  /** 0–100 — how engaged the customer is (call length, questions, callbacks). */
  engagementScore: integer("engagement_score").notNull().default(0),
  /** 0–100 — repeat/loyalty signal (existing Hero owner, repeat buyer, referrals). */
  loyaltyScore: integer("loyalty_score").notNull().default(0),
  /** 0–100 — how responsive the customer is to follow-ups (drives cadence). */
  followupScore: integer("followup_score").notNull().default(0),

  /** 0–100 probability this lead converts to a sale (Sales Intelligence). */
  purchaseProbability: integer("purchase_probability").notNull().default(0),
  /** Probability-weighted expected revenue in ₹ for the open opportunity. */
  expectedRevenue: integer("expected_revenue").notNull().default(0),
  /** Estimated lifetime value in ₹ — vehicle + finance + insurance + service +
   *  accessories + referral + future upgrade potential (Revenue Engine, Phase 13). */
  lifetimeValue: integer("lifetime_value").notNull().default(0),

  /** When the intelligence layer last recomputed scores for this lead. */
  intelligenceUpdatedAt: timestamp("intelligence_updated_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("leads_phone_unique").on(table.phone),
]);

export const insertLeadSchema = createInsertSchema(leadsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertLead = z.infer<typeof insertLeadSchema>;
export type Lead = typeof leadsTable.$inferSelect;
