import { Router, type IRouter } from "express";
import { eq, and, gte, lte, inArray, ilike, desc, sql } from "drizzle-orm";
import { db, campaignsTable, leadsTable, campaignRecipientsTable } from "@workspace/db";
import { sendWhatsAppMessage } from "../lib/whatsapp";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ── List campaigns ────────────────────────────────────────────────────────────
router.get("/campaigns", async (_req, res): Promise<void> => {
  const campaigns = await db.select().from(campaignsTable).orderBy(desc(campaignsTable.createdAt));
  res.json(campaigns);
});

// ── Create campaign ───────────────────────────────────────────────────────────
router.post("/campaigns", async (req, res): Promise<void> => {
  const { name, messageTemplate, filterStatus, filterScoreMin, filterScoreMax, filterModel } = req.body;
  if (!name || !messageTemplate) {
    res.status(400).json({ error: "name and messageTemplate are required" });
    return;
  }
  const [campaign] = await db.insert(campaignsTable).values({
    name,
    messageTemplate,
    filterStatus: filterStatus ?? [],
    filterScoreMin: filterScoreMin ?? 0,
    filterScoreMax: filterScoreMax ?? 100,
    filterModel: filterModel || null,
    status: "draft",
    targetCount: 0,
    sentCount: 0,
    failedCount: 0,
    repliedCount: 0,
  }).returning();
  res.status(201).json(campaign);
});

// ── Get campaign ──────────────────────────────────────────────────────────────
router.get("/campaigns/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [campaign] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, id));
  if (!campaign) { res.status(404).json({ error: "Not found" }); return; }
  res.json(campaign);
});

// ── Update campaign ───────────────────────────────────────────────────────────
router.patch("/campaigns/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { name, messageTemplate, filterStatus, filterScoreMin, filterScoreMax, filterModel } = req.body;
  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name;
  if (messageTemplate !== undefined) updates.messageTemplate = messageTemplate;
  if (filterStatus !== undefined) updates.filterStatus = filterStatus;
  if (filterScoreMin !== undefined) updates.filterScoreMin = filterScoreMin;
  if (filterScoreMax !== undefined) updates.filterScoreMax = filterScoreMax;
  if (filterModel !== undefined) updates.filterModel = filterModel || null;
  const [updated] = await db.update(campaignsTable).set(updates).where(eq(campaignsTable.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json(updated);
});

// ── Delete campaign ───────────────────────────────────────────────────────────
router.delete("/campaigns/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  await db.delete(campaignsTable).where(eq(campaignsTable.id, id));
  res.sendStatus(204);
});

// ── Preview audience ──────────────────────────────────────────────────────────
router.post("/campaigns/:id/preview", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [campaign] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, id));
  if (!campaign) { res.status(404).json({ error: "Not found" }); return; }
  const leads = await buildAudience(campaign);
  res.json({
    count: leads.length,
    leads: leads.slice(0, 50).map(l => ({
      id: l.id, name: l.name, phone: l.phone, status: l.status, score: l.score,
    })),
  });
});

// ── Analytics ─────────────────────────────────────────────────────────────────
router.get("/campaigns/:id/analytics", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [campaign] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, id));
  if (!campaign) { res.status(404).json({ error: "Not found" }); return; }

  // All recipients
  const recipients = await db
    .select({
      id: campaignRecipientsTable.id,
      leadId: campaignRecipientsTable.leadId,
      replied: campaignRecipientsTable.replied,
      repliedAt: campaignRecipientsTable.repliedAt,
      leadStatusAtSend: campaignRecipientsTable.leadStatusAtSend,
      leadScoreAtSend: campaignRecipientsTable.leadScoreAtSend,
      leadStatusAfter: campaignRecipientsTable.leadStatusAfter,
      leadScoreAfter: campaignRecipientsTable.leadScoreAfter,
      leadName: leadsTable.name,
      leadPhone: leadsTable.phone,
      currentStatus: leadsTable.status,
      currentScore: leadsTable.score,
    })
    .from(campaignRecipientsTable)
    .leftJoin(leadsTable, eq(campaignRecipientsTable.leadId, leadsTable.id))
    .where(eq(campaignRecipientsTable.campaignId, id))
    .orderBy(desc(campaignRecipientsTable.sentAt));

  const targeted = campaign.targetCount ?? 0;
  const sent = campaign.sentCount ?? 0;
  const failed = campaign.failedCount ?? 0;
  const replied = recipients.filter(r => r.replied).length;
  const becameHot = recipients.filter(r =>
    (r.currentStatus === "hot" || r.currentStatus === "converted") &&
    r.leadStatusAtSend !== "hot" && r.leadStatusAtSend !== "converted"
  ).length;
  const converted = recipients.filter(r => r.currentStatus === "converted").length;

  const responseRate = sent > 0 ? Math.round((replied / sent) * 100) : 0;
  const conversionRate = sent > 0 ? Math.round((converted / sent) * 100) : 0;
  const hotRate = sent > 0 ? Math.round((becameHot / sent) * 100) : 0;

  const responders = recipients
    .filter(r => r.replied)
    .map(r => ({
      leadId: r.leadId,
      leadName: r.leadName,
      leadPhone: r.leadPhone,
      repliedAt: r.repliedAt,
      statusAtSend: r.leadStatusAtSend,
      scoreAtSend: r.leadScoreAtSend,
      currentStatus: r.currentStatus,
      currentScore: r.currentScore,
    }));

  res.json({
    campaign: { id: campaign.id, name: campaign.name, status: campaign.status },
    funnel: { targeted, sent, failed, replied, becameHot, converted },
    rates: { responseRate, conversionRate, hotRate },
    responders,
    totalRecipients: recipients.length,
  });
});

// ── Send blast ────────────────────────────────────────────────────────────────
router.post("/campaigns/:id/send", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [campaign] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, id));
  if (!campaign) { res.status(404).json({ error: "Not found" }); return; }
  if (campaign.status === "running") {
    res.status(409).json({ error: "Campaign is already running" });
    return;
  }

  const leads = await buildAudience(campaign);

  // Clear old recipients and reset counters
  await db.delete(campaignRecipientsTable).where(eq(campaignRecipientsTable.campaignId, id));
  await db.update(campaignsTable)
    .set({ status: "running", targetCount: leads.length, sentCount: 0, failedCount: 0, repliedCount: 0 })
    .where(eq(campaignsTable.id, id));

  res.json({ message: "Campaign blast started", targetCount: leads.length });

  runBlast(id, campaign.messageTemplate, leads).catch(err => {
    logger.error({ err, campaignId: id }, "Campaign blast error");
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function buildAudience(campaign: typeof campaignsTable.$inferSelect) {
  const conditions = [
    gte(leadsTable.score, campaign.filterScoreMin ?? 0),
    lte(leadsTable.score, campaign.filterScoreMax ?? 100),
  ];
  const statuses = campaign.filterStatus as string[] | null;
  if (statuses && statuses.length > 0) {
    conditions.push(inArray(leadsTable.status, statuses));
  }
  if (campaign.filterModel) {
    conditions.push(ilike(leadsTable.interestedModel, `%${campaign.filterModel}%`));
  }
  const leads = await db.select().from(leadsTable).where(and(...conditions));
  return leads.filter(l => l.status !== "lost" && l.status !== "converted");
}

async function runBlast(
  campaignId: number,
  messageTemplate: string,
  leads: Array<typeof leadsTable.$inferSelect>
) {
  let sent = 0;
  let failed = 0;

  for (const lead of leads) {
    const message = messageTemplate
      .replace(/\{name\}/g, lead.name)
      .replace(/\{phone\}/g, lead.phone)
      .replace(/\{model\}/g, lead.interestedModel ?? "Hero bike");

    try {
      const success = await sendWhatsAppMessage(lead.phone, message);
      if (success) {
        // Insert recipient row
        await db.insert(campaignRecipientsTable).values({
          campaignId,
          leadId: lead.id,
          leadStatusAtSend: lead.status,
          leadScoreAtSend: lead.score,
          replied: false,
        }).onConflictDoNothing({
          target: [campaignRecipientsTable.campaignId, campaignRecipientsTable.leadId],
        });
        sent++;
      } else {
        failed++;
      }
    } catch {
      failed++;
    }

    if ((sent + failed) % 5 === 0 || sent + failed === leads.length) {
      await db.update(campaignsTable)
        .set({ sentCount: sent, failedCount: failed })
        .where(eq(campaignsTable.id, campaignId))
        .catch(() => {});
    }

    await new Promise(r => setTimeout(r, 2000));
  }

  await db.update(campaignsTable)
    .set({ status: "completed", sentCount: sent, failedCount: failed })
    .where(eq(campaignsTable.id, campaignId));

  logger.info({ campaignId, sent, failed }, "Campaign blast completed");
}

export default router;
