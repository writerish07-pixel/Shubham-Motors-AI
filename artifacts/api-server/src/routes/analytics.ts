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
    return { id: `call-${c.id}`, type, description, leadName: c.leadName ?? null, createdAt: c.createdAt.toISOString() };
  });
  res.json(activities);
});

// ── NEW: Competitor intelligence breakdown ────────────────────────────────────
router.get("/analytics/competitor-breakdown", async (_req, res): Promise<void> => {
  const rows = await db.execute(sql`
    SELECT competitor_mentioned AS competitor, competitor_reason AS reason, COUNT(*) AS mention_count
    FROM leads WHERE competitor_mentioned IS NOT NULL
    GROUP BY competitor_mentioned, competitor_reason ORDER BY mention_count DESC LIMIT 20
  `);
  const byComp: Record<string, { total: number; reasons: Record<string, number> }> = {};
  for (const row of rows.rows as Array<{ competitor: string; reason: string | null; mention_count: string }>) {
    if (!byComp[row.competitor]) byComp[row.competitor] = { total: 0, reasons: {} };
    byComp[row.competitor].total += parseInt(row.mention_count);
    if (row.reason) byComp[row.competitor].reasons[row.reason] = (byComp[row.competitor].reasons[row.reason] ?? 0) + parseInt(row.mention_count);
  }
  const total = Object.values(byComp).reduce((s, v) => s + v.total, 0) || 1;
  res.json(Object.entries(byComp).map(([name, v]) => ({
    name, count: v.total,
    percentage: Number(((v.total / total) * 100).toFixed(1)),
    topReason: Object.entries(v.reasons).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
  })).sort((a, b) => b.count - a.count));
});

// ── NEW: Buying timeline distribution ─────────────────────────────────────────
router.get("/analytics/buying-timeline", async (_req, res): Promise<void> => {
  const rows = await db.execute(sql`
    SELECT buying_timeline AS timeline, COUNT(*) AS count FROM leads
    WHERE buying_timeline IS NOT NULL GROUP BY buying_timeline ORDER BY count DESC
  `);
  const total = (rows.rows as Array<{ count: string }>).reduce((s, r) => s + parseInt(r.count), 0) || 1;
  res.json((rows.rows as Array<{ timeline: string; count: string }>).map(r => ({
    timeline: r.timeline, count: parseInt(r.count),
    percentage: Number(((parseInt(r.count) / total) * 100).toFixed(1)),
  })));
});

// ── NEW: Discovery signal coverage ────────────────────────────────────────────
router.get("/analytics/discovery-coverage", async (_req, res): Promise<void> => {
  const result = await db.execute(sql`
    SELECT COUNT(*) AS total_leads,
      COUNT(daily_km) AS has_km, COUNT(budget) AS has_budget,
      COUNT(family_info) AS has_family, COUNT(current_vehicle) AS has_vehicle,
      COUNT(competitor_mentioned) AS has_competitor, COUNT(buying_timeline) AS has_timeline
    FROM leads
  `);
  const r = (result.rows[0] as any) ?? {};
  const total = parseInt(r.total_leads) || 1;
  const pct = (n: string) => Number(((parseInt(n || "0") / total) * 100).toFixed(1));
  res.json({
    totalLeads: total,
    dailyKm: { count: parseInt(r.has_km || "0"), pct: pct(r.has_km) },
    budget: { count: parseInt(r.has_budget || "0"), pct: pct(r.has_budget) },
    familyInfo: { count: parseInt(r.has_family || "0"), pct: pct(r.has_family) },
    currentVehicle: { count: parseInt(r.has_vehicle || "0"), pct: pct(r.has_vehicle) },
    competitorMentioned: { count: parseInt(r.has_competitor || "0"), pct: pct(r.has_competitor) },
    buyingTimeline: { count: parseInt(r.has_timeline || "0"), pct: pct(r.has_timeline) },
  });
});

// ── NEW: Follow-up retry stats ────────────────────────────────────────────────
router.get("/analytics/retry-stats", async (_req, res): Promise<void> => {
  const rows = await db.execute(sql`
    SELECT COALESCE(attempt_count, 0) AS attempts, status, COUNT(*) AS count
    FROM followups GROUP BY attempt_count, status ORDER BY attempt_count, status
  `);
  const data = rows.rows as Array<{ attempts: string; status: string; count: string }>;
  res.json({
    attempt1: data.filter(r => parseInt(r.attempts) <= 1).reduce((s, r) => s + parseInt(r.count), 0),
    attempt2: data.filter(r => parseInt(r.attempts) === 2).reduce((s, r) => s + parseInt(r.count), 0),
    attempt3plus: data.filter(r => parseInt(r.attempts) >= 3).reduce((s, r) => s + parseInt(r.count), 0),
    whatsappFallback: data.filter(r => r.status === "whatsapp_fallback").reduce((s, r) => s + parseInt(r.count), 0),
    completed: data.filter(r => r.status === "completed").reduce((s, r) => s + parseInt(r.count), 0),
    raw: data,
  });
});

// ── NEW: KB self-learning pending counts ──────────────────────────────────────
router.get("/analytics/kb-pending-counts", async (_req, res): Promise<void> => {
  const rows = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE content LIKE '[agent_mistake]%') AS agent_mistakes,
      COUNT(*) FILTER (WHERE content LIKE '[price_correction]%') AS price_corrections,
      COUNT(*) FILTER (WHERE content LIKE '[new_objection]%') AS new_objections,
      COUNT(*) FILTER (WHERE content LIKE '[missing_info]%') AS missing_info,
      COUNT(*) AS total
    FROM knowledge WHERE requires_review = true AND is_active = false
  `);
  const r = (rows.rows[0] as any) ?? {};
  res.json({
    agentMistakes: parseInt(r.agent_mistakes || "0"),
    priceCorrections: parseInt(r.price_corrections || "0"),
    newObjections: parseInt(r.new_objections || "0"),
    missingInfo: parseInt(r.missing_info || "0"),
    total: parseInt(r.total || "0"),
  });
});

// ── NEW: Call intent distribution ─────────────────────────────────────────────
router.get("/analytics/intent-breakdown", async (_req, res): Promise<void> => {
  const rows = await db.execute(sql`
    SELECT intent_detected AS intent, COUNT(*) AS count, ROUND(AVG(score_after_call)) AS avg_score
    FROM calls WHERE intent_detected IS NOT NULL AND status = 'completed'
    GROUP BY intent_detected ORDER BY count DESC
  `);
  const total = (rows.rows as Array<{ count: string }>).reduce((s, r) => s + parseInt(r.count), 0) || 1;
  res.json((rows.rows as Array<{ intent: string; count: string; avg_score: string }>).map(r => ({
    intent: r.intent, count: parseInt(r.count),
    percentage: Number(((parseInt(r.count) / total) * 100).toFixed(1)),
    avgScore: Number(r.avg_score ?? 0),
  })));
});

export default router;
