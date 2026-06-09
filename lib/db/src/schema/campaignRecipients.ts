import { pgTable, serial, integer, boolean, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { campaignsTable } from "./campaigns";
import { leadsTable } from "./leads";

export const campaignRecipientsTable = pgTable("campaign_recipients", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").notNull().references(() => campaignsTable.id, { onDelete: "cascade" }),
  leadId: integer("lead_id").notNull().references(() => leadsTable.id, { onDelete: "cascade" }),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  replied: boolean("replied").notNull().default(false),
  repliedAt: timestamp("replied_at", { withTimezone: true }),
  leadStatusAtSend: text("lead_status_at_send"),
  leadScoreAtSend: integer("lead_score_at_send"),
  leadStatusAfter: text("lead_status_after"),
  leadScoreAfter: integer("lead_score_after"),
}, (table) => [
  uniqueIndex("campaign_recipients_campaign_lead_unique").on(table.campaignId, table.leadId),
]);

export type CampaignRecipient = typeof campaignRecipientsTable.$inferSelect;
