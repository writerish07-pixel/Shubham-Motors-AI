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

// Cached — fetchCompetitorIntel runs on EVERY LLM turn inside buildSystemPrompt.
// Loss-reason aggregates change slowly; an uncached DB query per turn adds a
// full DB roundtrip of latency to every agent reply.
const INTEL_CACHE_TTL_MS = 10 * 60_000;
let _intelCache: { value: CompetitorIntel; expiresAt: number } | null = null;

export async function fetchCompetitorIntel(limit = 5): Promise<CompetitorIntel> {
  if (_intelCache && _intelCache.expiresAt > Date.now()) return _intelCache.value;

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
    // Do not cache failures — retry on next turn.
    return { codealerReasons, competitorReasons };
  }

  const value = { codealerReasons, competitorReasons };
  _intelCache = { value, expiresAt: Date.now() + INTEL_CACHE_TTL_MS };
  return value;
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
