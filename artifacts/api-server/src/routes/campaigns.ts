import { Router, type IRouter } from "express";
import { eq, and, gte, lte, inArray, ilike, or } from "drizzle-orm";
import { db, campaignsTable, leadsTable } from "@workspace/db";
import { sendWhatsAppMessage } from "../lib/whatsapp";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ── List campaigns ────────────────────────────────────────────────────────────
router.get("/campaigns", async (_req, res): Promise<void> => {
  const campaigns = await db.select().from(campaignsTable).orderBy(campaignsTable.createdAt);
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
      id: l.id,
      name: l.name,
      phone: l.phone,
      status: l.status,
      score: l.score,
    })),
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

  // Update status to running and set target count
  await db.update(campaignsTable)
    .set({ status: "running", targetCount: leads.length, sentCount: 0, failedCount: 0 })
    .where(eq(campaignsTable.id, id));

  // Respond immediately so the client isn't blocked
  res.json({ message: "Campaign blast started", targetCount: leads.length });

  // Run async blast
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

  // Always exclude lost and converted (don't spam them)
  const excluded = ["lost", "converted"];
  const where = and(
    ...conditions,
    // @ts-ignore drizzle not accepting notInArray without explicit cast
    lte(leadsTable.score, campaign.filterScoreMax ?? 100)
  );

  const leads = await db.select().from(leadsTable).where(and(...conditions));
  return leads.filter(l => !excluded.includes(l.status));
}

async function runBlast(
  campaignId: number,
  messageTemplate: string,
  leads: Array<typeof leadsTable.$inferSelect>
) {
  let sent = 0;
  let failed = 0;

  for (const lead of leads) {
    // Personalise the message
    const message = messageTemplate
      .replace(/\{name\}/g, lead.name)
      .replace(/\{phone\}/g, lead.phone)
      .replace(/\{model\}/g, lead.interestedModel ?? "Hero bike");

    try {
      const success = await sendWhatsAppMessage(lead.phone, message);
      if (success) {
        sent++;
      } else {
        failed++;
      }
    } catch {
      failed++;
    }

    // Update progress every 5 messages or on last one
    if ((sent + failed) % 5 === 0 || sent + failed === leads.length) {
      await db.update(campaignsTable)
        .set({ sentCount: sent, failedCount: failed })
        .where(eq(campaignsTable.id, campaignId))
        .catch(() => {});
    }

    // 2-second delay between messages to respect rate limits
    await new Promise(r => setTimeout(r, 2000));
  }

  await db.update(campaignsTable)
    .set({ status: "completed", sentCount: sent, failedCount: failed })
    .where(eq(campaignsTable.id, campaignId));

  logger.info({ campaignId, sent, failed }, "Campaign blast completed");
}

export default router;
