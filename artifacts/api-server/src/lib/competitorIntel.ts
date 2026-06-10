/**
 * Aggregate recent loss reasons from CRM — reference sheets_manager.get_loss_reasons().
 * Injected into system prompt so Sakshi addresses common objections proactively.
 */

import { db, leadsTable } from "@workspace/db";
import { desc, isNotNull } from "drizzle-orm";
import { logger } from "./logger";

export interface CompetitorIntel {
  codealerReasons: string[];
  competitorReasons: string[];
}

export async function fetchCompetitorIntel(limit = 5): Promise<CompetitorIntel> {
  const codealerReasons: string[] = [];
  const competitorReasons: string[] = [];

  try {
    const rows = await db
      .select({
        lostToBrand: leadsTable.lostToBrand,
        lostToDealer: leadsTable.lostToDealer,
        lostReason: leadsTable.lostReason,
        competitorMentioned: leadsTable.competitorMentioned,
        competitorReason: leadsTable.competitorReason,
      })
      .from(leadsTable)
      .where(isNotNull(leadsTable.lostReason))
      .orderBy(desc(leadsTable.updatedAt))
      .limit(30);

    for (const r of rows) {
      if (r.lostToDealer && r.lostReason && codealerReasons.length < limit) {
        codealerReasons.push(`${r.lostToDealer}: ${r.lostReason}`);
      }
      if (r.lostToBrand && r.lostReason && competitorReasons.length < limit) {
        competitorReasons.push(`${r.lostToBrand}: ${r.lostReason}`);
      } else if (r.competitorMentioned && r.competitorReason && competitorReasons.length < limit) {
        competitorReasons.push(`${r.competitorMentioned}: ${r.competitorReason}`);
      }
    }
  } catch (err) {
    logger.warn({ err }, "competitorIntel fetch failed");
  }

  return { codealerReasons, competitorReasons };
}

export function formatCompetitorIntelBlock(intel: CompetitorIntel): string {
  if (intel.codealerReasons.length === 0 && intel.competitorReasons.length === 0) return "";
  const lines: string[] = ["╔══ COMPETITOR INTELLIGENCE (learn from past losses) ══╗"];
  if (intel.competitorReasons.length) {
    lines.push("Recent competitor concerns — address respectfully if customer mentions:");
    intel.competitorReasons.forEach((r) => lines.push(`• ${r}`));
  }
  if (intel.codealerReasons.length) {
    lines.push("Other dealer wins — highlight Hero service/resale, never insult:");
    intel.codealerReasons.forEach((r) => lines.push(`• ${r}`));
  }
  lines.push("╚═══════════════════════════════════════════════════════╝");
  return lines.join("\n");
}
