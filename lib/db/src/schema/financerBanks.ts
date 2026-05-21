import { pgTable, text, serial, timestamp, boolean } from "drizzle-orm/pg-core";

export const financerBanksTable = pgTable("financer_banks", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type FinancerBank = typeof financerBanksTable.$inferSelect;
export type InsertFinancerBank = typeof financerBanksTable.$inferInsert;
