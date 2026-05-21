import { pgTable, text, serial, timestamp, boolean } from "drizzle-orm/pg-core";

// type = "sales" | "finance"
// For finance contacts, bankName must be set (e.g. "HDFC Bank", "Hero FinCorp").
// For sales contacts, bankName is null and `name` is the salesperson name.
export const contactsTable = pgTable("contacts", {
  id: serial("id").primaryKey(),
  type: text("type").notNull(),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  bankName: text("bank_name"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type Contact = typeof contactsTable.$inferSelect;
export type InsertContact = typeof contactsTable.$inferInsert;
