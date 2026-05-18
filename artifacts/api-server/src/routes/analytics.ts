import { Router, type IRouter } from "express";
import { eq, count, avg, sql } from "drizzle-orm";
import { db, leadsTable, callsTable, followupsTable } from "@workspace/db";
import { GetCallPerformanceQueryParams } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/analytics/dashboard", async (_req, res): Promise<void> => {
  const [leadsStats] = await db.select({
    totalLeads: count(),
    avgScore: avg(leadsTable.score),
  }).from(leadsTable);

  const [hotLeadsCount] = await db.select({ count: count() }).from(leadsTable)
    .where(eq(leadsTable.status, "hot"));

  const [convertedCount] = await db.select({ count: count() }).from(leadsTable)
    .where(eq(leadsTable.status, "converted"));

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [callsToday] = await db.select({ count: count() }).from(callsTable)
    .where(sql`${callsTable.createdAt} >= ${today}`);

  const [totalCalls] = await db.select({ count: count() }).from(callsTable);

  const [whatsappCount] = await db.select({ count: count() }).from(callsTable)
    .where(eq(callsTable.whatsappSent, true));

  const [followupsDue] = await db.select({ count: count() }).from(followupsTable)
    .where(sql`${followupsTable.status} = 'pending' AND ${followupsTable.scheduledAt} <= NOW()`);

  const total = leadsStats?.totalLeads ?? 0;
  const converted = convertedCount?.count ?? 0;

  res.json({
    totalLeads: total,
    hotLeads: hotLeadsCount?.count ?? 0,
    callsToday: callsToday?.count ?? 0,
    conversionRate: total > 0 ? Number(((converted / total) * 100).toFixed(1)) : 0,
    followupsDue: followupsDue?.count ?? 0,
    avgLeadScore: Number(Number(leadsStats?.avgScore ?? 0).toFixed(1)),
    totalCalls: totalCalls?.count ?? 0,
    whatsappSent: whatsappCount?.count ?? 0,
  });
});

router.get("/analytics/lead-funnel", async (_req, res): Promise<void> => {
  const statuses = ["new", "contacted", "interested", "hot", "converted", "lost"];
  const [totalRow] = await db.select({ count: count() }).from(leadsTable);
  const total = totalRow?.count ?? 1;

  const results = [];
  for (const status of statuses) {
    const [row] = await db.select({ count: count() }).from(leadsTable)
      .where(eq(leadsTable.status, status));
    const c = row?.count ?? 0;
    results.push({
      stage: status.charAt(0).toUpperCase() + status.slice(1),
      count: c,
      percentage: Number(((c / total) * 100).toFixed(1)),
    });
  }

  res.json(results);
});

router.get("/analytics/call-performance", async (req, res): Promise<void> => {
  const params = GetCallPerformanceQueryParams.safeParse(req.query);
  const days = params.success && params.data.days ? Number(params.data.days) : 7;

  const rows = await db.select({
    date: sql<string>`DATE(${callsTable.createdAt})::text`,
    totalCalls: count(),
    completed: sql<number>`COUNT(*) FILTER (WHERE ${callsTable.status} = 'completed')`,
    transferred: sql<number>`COUNT(*) FILTER (WHERE ${callsTable.status} = 'transferred')`,
    avgDuration: avg(callsTable.duration),
  })
    .from(callsTable)
    .where(sql`${callsTable.createdAt} >= NOW() - INTERVAL '${sql.raw(String(days))} days'`)
    .groupBy(sql`DATE(${callsTable.createdAt})`)
    .orderBy(sql`DATE(${callsTable.createdAt})`);

  res.json(rows.map((r) => ({
    date: r.date,
    totalCalls: Number(r.totalCalls),
    completed: Number(r.completed),
    transferred: Number(r.transferred),
    avgDuration: Number(Number(r.avgDuration ?? 0).toFixed(1)),
  })));
});

router.get("/analytics/hot-leads", async (_req, res): Promise<void> => {
  const leads = await db.select().from(leadsTable)
    .where(sql`${leadsTable.status} IN ('hot', 'interested')`)
    .orderBy(sql`${leadsTable.score} DESC`)
    .limit(10);

  res.json(leads);
});

router.get("/analytics/recent-activity", async (_req, res): Promise<void> => {
  const recentCalls = await db.select({
    id: callsTable.id,
    leadId: callsTable.leadId,
    leadName: leadsTable.name,
    status: callsTable.status,
    direction: callsTable.direction,
    whatsappSent: callsTable.whatsappSent,
    createdAt: callsTable.createdAt,
  })
    .from(callsTable)
    .leftJoin(leadsTable, eq(callsTable.leadId, leadsTable.id))
    .orderBy(sql`${callsTable.createdAt} DESC`)
    .limit(20);

  const activities = recentCalls.map((c) => {
    let type: string;
    let description: string;

    if (c.status === "transferred") {
      type = "call_transferred";
      description = `Call with ${c.leadName ?? "Unknown"} transferred to sales team`;
    } else if (c.status === "missed") {
      type = "call_missed";
      description = `Missed ${c.direction} call from ${c.leadName ?? "Unknown"}`;
    } else if (c.whatsappSent) {
      type = "whatsapp_sent";
      description = `WhatsApp summary sent to ${c.leadName ?? "Unknown"}`;
    } else {
      type = "call_completed";
      description = `${c.direction === "inbound" ? "Inbound" : "Outbound"} call with ${c.leadName ?? "Unknown"} completed`;
    }

    return {
      id: `call-${c.id}`,
      type,
      description,
      leadName: c.leadName ?? null,
      createdAt: c.createdAt.toISOString(),
    };
  });

  res.json(activities);
});

export default router;
