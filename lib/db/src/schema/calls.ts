import { pgTable, text, serial, timestamp, integer, boolean, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const callsTable = pgTable("calls", {
  id: serial("id").primaryKey(),
  leadId: integer("lead_id").notNull(),
  direction: text("direction").notNull().default("inbound"),
  status: text("status").notNull().default("initiated"),
  duration: integer("duration"),
  transcript: text("transcript"),
  summary: text("summary"),
  intentDetected: text("intent_detected"),
  scoreAfterCall: integer("score_after_call"),
  languageDetected: text("language_detected"),
  whatsappSent: boolean("whatsapp_sent").notNull().default(false),
  transferredTo: text("transferred_to"),
  exotelCallSid: text("exotel_call_sid"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  // Looked up on every call-stream event in callStream.ts — index it.
  exotelCallSidIdx: index("calls_exotel_call_sid_idx").on(t.exotelCallSid),
  leadIdIdx: index("calls_lead_id_idx").on(t.leadId),
}));

export const insertCallSchema = createInsertSchema(callsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCall = z.infer<typeof insertCallSchema>;
export type Call = typeof callsTable.$inferSelect;
