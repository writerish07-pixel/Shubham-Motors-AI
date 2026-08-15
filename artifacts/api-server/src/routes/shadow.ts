import { Router, type IRouter } from "express";
import { desc, eq, sql } from "drizzle-orm";
import { db, callsTable, leadsTable, shadowScoresTable } from "@workspace/db";

const router: IRouter = Router();

router.get("/shadow/summary", async (_req, res): Promise<void> => {
  const rows = await db.execute(sql`
    SELECT
      COUNT(*)::int AS n,
      COALESCE(ROUND(AVG(overall)), 0)::int AS overall,
      COALESCE(ROUND(AVG(completeness)), 0)::int AS completeness,
      COALESCE(ROUND(AVG(grounding)), 0)::int AS grounding,
      COALESCE(ROUND(AVG(booking)), 0)::int AS booking,
      COALESCE(ROUND(AVG(handoff)), 0)::int AS handoff,
      COALESCE(ROUND(AVG(talk_ratio)), 0)::int AS "talkRatio",
      COALESCE(ROUND(AVG(filler_penalty)), 0)::int AS "fillerPenalty"
    FROM shadow_scores
  `);
  res.json(rows.rows[0] ?? { n: 0, overall: 0 });
});

router.get("/shadow", async (req, res): Promise<void> => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const rows = await db
    .select({
      id: shadowScoresTable.id,
      callId: shadowScoresTable.callId,
      leadId: shadowScoresTable.leadId,
      completeness: shadowScoresTable.completeness,
      grounding: shadowScoresTable.grounding,
      booking: shadowScoresTable.booking,
      handoff: shadowScoresTable.handoff,
      talkRatio: shadowScoresTable.talkRatio,
      fillerPenalty: shadowScoresTable.fillerPenalty,
      overall: shadowScoresTable.overall,
      notes: shadowScoresTable.notes,
      createdAt: shadowScoresTable.createdAt,
      leadName: leadsTable.name,
      direction: callsTable.direction,
      intentDetected: callsTable.intentDetected,
    })
    .from(shadowScoresTable)
    .leftJoin(leadsTable, eq(shadowScoresTable.leadId, leadsTable.id))
    .leftJoin(callsTable, eq(shadowScoresTable.callId, callsTable.id))
    .orderBy(desc(shadowScoresTable.createdAt))
    .limit(limit);
  res.json(rows);
});

export default router;
