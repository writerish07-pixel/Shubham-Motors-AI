import { pgTable, text, serial, timestamp, integer, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/** GM-editable showroom / test-ride slots (capacity is usually 1 per desk). */
export const visitSlotsTable = pgTable("visit_slots", {
  id: serial("id").primaryKey(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  capacity: integer("capacity").notNull().default(1),
  bookedCount: integer("booked_count").notNull().default(0),
  label: text("label"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("visit_slots_starts_at_unique").on(table.startsAt),
]);

export const insertVisitSlotSchema = createInsertSchema(visitSlotsTable).omit({ id: true, createdAt: true });
export type InsertVisitSlot = z.infer<typeof insertVisitSlotSchema>;
export type VisitSlot = typeof visitSlotsTable.$inferSelect;
