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

// ── NEW: Revenue Engine — pipeline, expected & lifetime value (PRD Phase 13) ──
router.get("/analytics/revenue-pipeline", async (_req, res): Promise<void> => {
  const totals = await db.execute(sql`
    SELECT
      COALESCE(SUM(expected_revenue), 0) AS expected_revenue,
      COALESCE(SUM(lifetime_value), 0) AS lifetime_value,
      COALESCE(SUM(expected_revenue) FILTER (WHERE status NOT IN ('lost','not_interested','wrong_number','converted')), 0) AS open_pipeline,
      COALESCE(SUM(expected_revenue) FILTER (WHERE status = 'lost'), 0) AS lost_revenue,
      COALESCE(SUM(expected_revenue) FILTER (WHERE purchase_probability >= 60), 0) AS committed_revenue,
      COALESCE(ROUND(AVG(purchase_probability)), 0) AS avg_probability
    FROM leads
  `);
  const byStage = await db.execute(sql`
    SELECT purchase_stage AS stage, COUNT(*) AS leads,
      COALESCE(SUM(expected_revenue), 0) AS expected_revenue
    FROM leads WHERE purchase_stage IS NOT NULL
    GROUP BY purchase_stage ORDER BY expected_revenue DESC
  `);
  const t = (totals.rows[0] as any) ?? {};
  res.json({
    expectedRevenue: Number(t.expected_revenue ?? 0),
    lifetimeValue: Number(t.lifetime_value ?? 0),
    openPipeline: Number(t.open_pipeline ?? 0),
    lostRevenue: Number(t.lost_revenue ?? 0),
    committedRevenue: Number(t.committed_revenue ?? 0),
    avgProbability: Number(t.avg_probability ?? 0),
    byStage: (byStage.rows as Array<{ stage: string; leads: string; expected_revenue: string }>).map((r) => ({
      stage: r.stage,
      leads: parseInt(r.leads),
      expectedRevenue: Number(r.expected_revenue ?? 0),
    })),
  });
});

// ── NEW: Relationship CRM — score distribution & persona mix (PRD Phase 3/11) ──
router.get("/analytics/relationships", async (_req, res): Promise<void> => {
  const agg = await db.execute(sql`
    SELECT
      COUNT(*) AS total_leads,
      COALESCE(ROUND(AVG(relationship_score)), 0) AS avg_relationship,
      COALESCE(ROUND(AVG(trust_score)), 0) AS avg_trust,
      COALESCE(ROUND(AVG(engagement_score)), 0) AS avg_engagement,
      COALESCE(ROUND(AVG(loyalty_score)), 0) AS avg_loyalty,
      COUNT(*) FILTER (WHERE relationship_score >= 70) AS strong,
      COUNT(*) FILTER (WHERE relationship_score >= 40 AND relationship_score < 70) AS warm,
      COUNT(*) FILTER (WHERE relationship_score > 0 AND relationship_score < 40) AS at_risk
    FROM leads
  `);
  const personas = await db.execute(sql`
    SELECT customer_persona AS persona, COUNT(*) AS count
    FROM leads WHERE customer_persona IS NOT NULL
    GROUP BY customer_persona ORDER BY count DESC
  `);
  const a = (agg.rows[0] as any) ?? {};
  res.json({
    totalLeads: Number(a.total_leads ?? 0),
    avgRelationshipScore: Number(a.avg_relationship ?? 0),
    avgTrustScore: Number(a.avg_trust ?? 0),
    avgEngagementScore: Number(a.avg_engagement ?? 0),
    avgLoyaltyScore: Number(a.avg_loyalty ?? 0),
    strong: Number(a.strong ?? 0),
    warm: Number(a.warm ?? 0),
    atRisk: Number(a.at_risk ?? 0),
    personaMix: (personas.rows as Array<{ persona: string; count: string }>).map((r) => ({
      persona: r.persona,
      count: parseInt(r.count),
    })),
  });
});

// GM employee scorecard — visits, finance, quality, leakage, revenue
router.get("/analytics/employee-scorecard", async (_req, res): Promise<void> => {
  try {
    const row = await db.execute(sql`
      SELECT
        (SELECT COUNT(*) FROM leads WHERE visit_scheduled_at IS NOT NULL) AS visits_booked,
        (SELECT COUNT(*) FROM visit_bookings WHERE status = 'booked') AS visit_rows,
        (SELECT COUNT(*) FROM calls WHERE transferred_to ILIKE '%finance%') AS finance_transfers,
        (SELECT COUNT(*) FROM followups WHERE status IN ('completed','done')) AS followups_done,
        (SELECT COUNT(*) FROM followups WHERE status = 'pending' AND scheduled_at <= NOW()) AS followups_overdue,
        (SELECT COALESCE(ROUND(AVG(overall)), 0) FROM shadow_scores) AS shadow_quality,
        (SELECT COUNT(*) FROM leads WHERE competitor_mentioned IS NOT NULL) AS competitor_mentions,
        (SELECT COALESCE(SUM(expected_revenue), 0) FROM leads WHERE status NOT IN ('lost','not_interested','wrong_number')) AS open_revenue,
        (SELECT COALESCE(ROUND(AVG(relationship_score)), 0) FROM leads WHERE relationship_score > 0) AS avg_relationship,
        (SELECT COALESCE(ROUND(AVG(csat_score)), 0) FROM leads WHERE csat_score IS NOT NULL) AS avg_csat,
        (SELECT COUNT(*) FROM calls WHERE greeting_played = false) AS silent_greetings,
        (SELECT COUNT(*) FROM calls WHERE greeting_played = true) AS greetings_ok,
        (SELECT COALESCE(ROUND(AVG(avg_turn_ms)), 0) FROM calls WHERE avg_turn_ms IS NOT NULL) AS avg_turn_ms,
        (SELECT COALESCE(ROUND(AVG(barge_in_count)), 0) FROM calls WHERE barge_in_count IS NOT NULL) AS avg_barge_ins
    `);
    const r = (row.rows[0] as Record<string, string>) ?? {};
    const num = (k: string) => Number(r[k] ?? 0);
    res.json({
      visitsBooked: num("visits_booked"),
      visitRows: num("visit_rows"),
      financeTransfers: num("finance_transfers"),
      followupsDone: num("followups_done"),
      followupsOverdue: num("followups_overdue"),
      shadowQuality: num("shadow_quality"),
      competitorMentions: num("competitor_mentions"),
      openRevenue: num("open_revenue"),
      avgRelationship: num("avg_relationship"),
      avgCsat: num("avg_csat"),
      silentGreetings: num("silent_greetings"),
      greetingsOk: num("greetings_ok"),
      avgTurnMs: num("avg_turn_ms"),
      avgBargeIns: num("avg_barge_ins"),
    });
  } catch {
    res.json({
      visitsBooked: 0, visitRows: 0, financeTransfers: 0, followupsDone: 0,
      followupsOverdue: 0, shadowQuality: 0, competitorMentions: 0, openRevenue: 0,
      avgRelationship: 0, avgCsat: 0, silentGreetings: 0, greetingsOk: 0,
      avgTurnMs: 0, avgBargeIns: 0, error: "scorecard_unavailable",
    });
  }
});

export default router;
