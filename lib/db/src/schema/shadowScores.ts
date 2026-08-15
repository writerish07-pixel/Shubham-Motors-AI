import { pgTable, text, serial, timestamp, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/** Heuristic scorecard vs a human telecaller — written after every completed call. */
export const shadowScoresTable = pgTable("shadow_scores", {
  id: serial("id").primaryKey(),
  callId: integer("call_id").notNull(),
  leadId: integer("lead_id").notNull(),
  completeness: integer("completeness").notNull().default(0),
  grounding: integer("grounding").notNull().default(0),
  booking: integer("booking").notNull().default(0),
  handoff: integer("handoff").notNull().default(0),
  talkRatio: integer("talk_ratio").notNull().default(0),
  fillerPenalty: integer("filler_penalty").notNull().default(0),
  overall: integer("overall").notNull().default(0),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("shadow_scores_call_id_idx").on(table.callId),
  index("shadow_scores_created_at_idx").on(table.createdAt),
]);

export const insertShadowScoreSchema = createInsertSchema(shadowScoresTable).omit({ id: true, createdAt: true });
export type InsertShadowScore = z.infer<typeof insertShadowScoreSchema>;
export type ShadowScore = typeof shadowScoresTable.$inferSelect;
