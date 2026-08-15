import { pgTable, text, serial, timestamp, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const visitBookingsTable = pgTable("visit_bookings", {
  id: serial("id").primaryKey(),
  slotId: integer("slot_id").notNull(),
  leadId: integer("lead_id").notNull(),
  /** booked | cancelled | completed | noshow */
  status: text("status").notNull().default("booked"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("visit_bookings_slot_id_idx").on(table.slotId),
  index("visit_bookings_lead_id_idx").on(table.leadId),
]);

export const insertVisitBookingSchema = createInsertSchema(visitBookingsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertVisitBooking = z.infer<typeof insertVisitBookingSchema>;
export type VisitBooking = typeof visitBookingsTable.$inferSelect;
