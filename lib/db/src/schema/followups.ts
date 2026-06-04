import { pgTable, text, serial, timestamp, integer, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const followupsTable = pgTable("followups", {
  id: serial("id").primaryKey(),
  leadId: integer("lead_id").notNull(),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  status: text("status").notNull().default("pending"),
  // status values: "pending" | "completed" | "failed" | "cancelled" | "whatsapp_fallback"
  reason: text("reason").notNull(),
  intentLabel: text("intent_label"),
  callId: integer("call_id"),

  // ── Retry tracking columns (added June 2026 audit) ────────────────────────
  // Tracks how many outbound call attempts have been made for this follow-up.
  // The scheduler increments attemptCount on each attempt and reschedules
  // +retryDelayMinutes if the call fails or goes unanswered.
  // When attemptCount >= maxAttempts, the scheduler sends a WhatsApp fallback
  // and marks status = 'whatsapp_fallback'.

  /** Number of outbound call attempts made so far */
  attemptCount: integer("attempt_count").notNull().default(0),

  /** Maximum attempts before switching to WhatsApp fallback */
  maxAttempts: integer("max_attempts").notNull().default(3),

  /** Timestamp of the most recent call attempt — used for retry window calc */
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),

  /**
   * Lead context snapshot to inject into the outbound call session.
   * Set by the scheduler just before placing the call. callStream.ts
   * reads this via getOutboundContext(phone) so Sakshi can open with
   * "aapne pichli baar Splendor dekhi thi..." instead of a generic greeting.
   * Stored as JSONB: { name, interestedModel, notes, lastCallSummary, followupReason }
   */
  outboundContext: jsonb("outbound_context"),

  /** Delivery channel for this follow-up */
  channel: text("channel").notNull().default("call"), // "call" | "whatsapp" | "sms"

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertFollowupSchema = createInsertSchema(followupsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertFollowup = z.infer<typeof insertFollowupSchema>;
export type Followup = typeof followupsTable.$inferSelect;
