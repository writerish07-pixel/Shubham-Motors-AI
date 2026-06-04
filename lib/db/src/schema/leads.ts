import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
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
  buyingTimeline: text("buying_timeline"), // "immediate" | "15days" | "month" | "festival" | "next_year"

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertLeadSchema = createInsertSchema(leadsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertLead = z.infer<typeof insertLeadSchema>;
export type Lead = typeof leadsTable.$inferSelect;
