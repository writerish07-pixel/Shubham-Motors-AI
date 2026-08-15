import { pgTable, text, serial, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const knowledgeTable = pgTable("knowledge", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  category: text("category").notNull().default("general"),
  content: text("content").notNull(),
  modelName: text("model_name"),
  fileUrl: text("file_url"),
  isActive: boolean("is_active").notNull().default(true),
  requiresReview: boolean("requires_review").notNull().default(false),
  evidence: text("evidence"),
  source: text("source"),
  /** Inclusive start — expired / not-yet-live rows are skipped at retrieve time. */
  effectiveFrom: timestamp("effective_from", { withTimezone: true }),
  effectiveUntil: timestamp("effective_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertKnowledgeSchema = createInsertSchema(knowledgeTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertKnowledge = z.infer<typeof insertKnowledgeSchema>;
export type Knowledge = typeof knowledgeTable.$inferSelect;
