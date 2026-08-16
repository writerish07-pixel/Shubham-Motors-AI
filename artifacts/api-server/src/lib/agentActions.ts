/**
 * DB-backed tool execution for voice tags: EMI quote, stock, visit, WhatsApp, transfer flag.
 */
import { and, count, eq, gte, lt, sql } from "drizzle-orm";
import {
  db,
  callsTable,
  knowledgeTable,
  leadsTable,
  visitBookingsTable,
  visitSlotsTable,
} from "@workspace/db";
import { resolveModelOnRoad, formatEmiQuote, DEFAULT_ANNUAL_RATE } from "./emiQuote";
import {
  type AgentTag,
  exceedsFrequencyCap,
  frequencyWindowMs,
  ncprBlocksOutbound,
  outboundDialingAllowed,
} from "./agentTools";
import { sendBrochureWhatsApp, sendCallSummaryWhatsApp, sendWhatsAppMessage } from "./whatsapp";
import { logger } from "./logger";

export type ToolContext = {
  leadId: number;
  callSid?: string;
  language: string;
  customerText: string;
  leadName: string;
  leadPhone?: string | null;
};

export type ToolResult = {
  spokenExtras: string[];
  transferRequested: boolean;
  visitBookedAt: Date | null;
  whatsappQueued: boolean;
};

export async function executeAgentTools(tags: AgentTag[], ctx: ToolContext): Promise<ToolResult> {
  const result: ToolResult = {
    spokenExtras: [],
    transferRequested: false,
    visitBookedAt: null,
    whatsappQueued: false,
  };
  if (tags.length === 0) return result;

  const [lead] = ctx.leadId
    ? await db.select().from(leadsTable).where(eq(leadsTable.id, ctx.leadId)).limit(1)
    : [];
  const phone = ctx.leadPhone ?? lead?.phone ?? null;
  const name = ctx.leadName || lead?.name || "Sir";

  for (const tag of tags) {
    try {
      if (tag.kind === "TRANSFER") {
        result.transferRequested = true;
        continue;
      }
      if (tag.kind === "EMI") {
        const spoken = quoteFromEmiTag(tag.arg, ctx.customerText);
        if (spoken) result.spokenExtras.push(spoken);
        continue;
      }
      if (tag.kind === "STOCK") {
        const spoken = await stockLine(tag.arg || ctx.customerText);
        if (spoken) result.spokenExtras.push(spoken);
        continue;
      }
      if (tag.kind === "VISIT") {
        const booked = await bookNextOpenSlot(ctx.leadId, parseVisitHint(tag.arg));
        if (booked) {
          result.visitBookedAt = booked.startsAt;
          const when = booked.startsAt.toLocaleString("en-IN", {
            timeZone: "Asia/Kolkata",
            weekday: "short",
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          });
          result.spokenExtras.push(`Test ride ${when} par Lal Kothi showroom mein confirm hai.`);
        }
        continue;
      }
      if (tag.kind === "WHATSAPP" && phone) {
        result.whatsappQueued = true;
        const kind = tag.arg.toLowerCase();
        if (kind.startsWith("brochure")) {
          const model = lead?.interestedModel ?? tag.arg.replace(/^brochure:?/i, "").trim();
          const brochures = await db.select().from(knowledgeTable).where(eq(knowledgeTable.category, "brochure"));
          const key = (model || "").toLowerCase().split(/\s+/)[0] ?? "";
          const brochure =
            brochures.find((b) => b.fileUrl && key && b.title?.toLowerCase().includes(key))
            ?? brochures.find((b) => b.fileUrl);
          if (brochure?.fileUrl && model) {
            void sendBrochureWhatsApp(phone, name, model, brochure.fileUrl, ctx.language).catch((err) =>
              logger.warn({ err }, "Tool WhatsApp brochure failed"),
            );
          } else {
            void sendWhatsAppMessage(
              phone,
              `Namaste ${name} ji — Shubham Motors, Lal Kothi. Brochure ke liye showroom par call kijiye 0141-4937655.`,
            ).catch(() => {});
          }
        } else {
          void sendCallSummaryWhatsApp(
            phone,
            name,
            "Aapki enquiry note ho gayi hai. Test ride ke liye Lal Kothi, Tonk Road par padharein.",
            lead?.interestedModel,
            ctx.language,
          ).catch((err) => logger.warn({ err }, "Tool WhatsApp summary failed"));
        }
      }
    } catch (err) {
      logger.warn({ err, tag }, "Agent tool failed");
    }
  }
  return result;
}

function quoteFromEmiTag(arg: string, customerText: string): string | null {
  const parts = arg.split("|").map((s) => s.trim()).filter(Boolean);
  const hay = `${parts[0] ?? ""} ${customerText}`;
  const resolved = resolveModelOnRoad(hay, parts[0]);
  if (!resolved) return null;
  const down = Number(parts[1]?.replace(/,/g, "")) || 25000;
  const months = Number(parts[2]) || 24;
  const rateRaw = Number(parts[3]);
  const rate = Number.isFinite(rateRaw) && rateRaw > 1 ? rateRaw / 100 : Number.isFinite(rateRaw) && rateRaw > 0 ? rateRaw : DEFAULT_ANNUAL_RATE;
  return formatEmiQuote(resolved.model, resolved.onRoad, down, months, rate);
}

async function stockLine(query: string): Promise<string | null> {
  const rows = await db.select().from(knowledgeTable).where(eq(knowledgeTable.category, "stock"));
  const token = query.toLowerCase().split(/\s+/).find((w) => w.length >= 4) ?? query.toLowerCase();
  const hit = rows.find((r) => r.title.toLowerCase().includes(token) || r.content.toLowerCase().includes(token));
  if (!hit) return null;
  return `${hit.title}: ${hit.content}`;
}

function parseVisitHint(arg: string): Date | undefined {
  if (!arg) return undefined;
  const d = new Date(arg);
  if (!Number.isNaN(d.getTime())) return d;
  return undefined;
}

export async function bookNextOpenSlot(
  leadId: number,
  preferred?: Date,
): Promise<{ slotId: number; startsAt: Date } | null> {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + 14 * 24 * 3600_000);
  const preferFrom = preferred && preferred > now ? preferred : now;
  const preferTo = preferred
    ? new Date(preferred.getTime() + 3 * 3600_000)
    : windowEnd;

  const slots = await db
    .select()
    .from(visitSlotsTable)
    .where(and(
      eq(visitSlotsTable.isActive, true),
      gte(visitSlotsTable.startsAt, preferFrom),
      lt(visitSlotsTable.startsAt, preferTo),
    ))
    .orderBy(visitSlotsTable.startsAt)
    .limit(40);

  let chosen = slots.find((s) => s.bookedCount < s.capacity);
  if (!chosen && preferred) {
    const fallback = await db
      .select()
      .from(visitSlotsTable)
      .where(and(
        eq(visitSlotsTable.isActive, true),
        gte(visitSlotsTable.startsAt, now),
        lt(visitSlotsTable.startsAt, windowEnd),
      ))
      .orderBy(visitSlotsTable.startsAt)
      .limit(40);
    chosen = fallback.find((s) => s.bookedCount < s.capacity);
  }
  if (!chosen) return null;

  const updated = await db
    .update(visitSlotsTable)
    .set({ bookedCount: sql`${visitSlotsTable.bookedCount} + 1` })
    .where(and(
      eq(visitSlotsTable.id, chosen.id),
      lt(visitSlotsTable.bookedCount, chosen.capacity),
    ))
    .returning();
  if (updated.length === 0) return null;

  await db.insert(visitBookingsTable).values({
    slotId: chosen.id,
    leadId,
    status: "booked",
  });
  await db.update(leadsTable).set({ visitScheduledAt: chosen.startsAt }).where(eq(leadsTable.id, leadId));
  return { slotId: chosen.id, startsAt: chosen.startsAt };
}

export async function countOutboundCallsSince(leadId: number, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(callsTable)
    .where(and(
      eq(callsTable.leadId, leadId),
      eq(callsTable.direction, "outbound"),
      gte(callsTable.createdAt, since),
    ));
  return Number(row?.n ?? 0);
}

export async function evaluateOutboundGates(lead: {
  id: number;
  doNotCall?: boolean | null;
  ncprStatus?: string | null;
}): Promise<{ ok: boolean; reason: string }> {
  if (!outboundDialingAllowed()) {
    return { ok: false, reason: `replacement_mode=${process.env.REPLACEMENT_MODE ?? "full"} — autodialer off` };
  }
  if (lead.doNotCall) return { ok: false, reason: "do-not-call" };
  if (ncprBlocksOutbound(lead.ncprStatus)) {
    return { ok: false, reason: `ncpr=${lead.ncprStatus ?? "unknown"}` };
  }
  const n = await countOutboundCallsSince(lead.id, new Date(Date.now() - frequencyWindowMs()));
  if (exceedsFrequencyCap(n)) {
    return { ok: false, reason: `frequency_cap (${n} outbound calls in window)` };
  }
  return { ok: true, reason: "ok" };
}

/** Manual CRM click-to-call: DND / NCPR / frequency only (GM override of replacement mode). */
export async function evaluateManualOutboundGates(lead: {
  id: number;
  doNotCall?: boolean | null;
  ncprStatus?: string | null;
}): Promise<{ ok: boolean; reason: string }> {
  if (lead.doNotCall) return { ok: false, reason: "do-not-call" };
  if (ncprBlocksOutbound(lead.ncprStatus)) {
    return { ok: false, reason: `ncpr=${lead.ncprStatus ?? "unknown"}` };
  }
  const n = await countOutboundCallsSince(lead.id, new Date(Date.now() - frequencyWindowMs()));
  if (exceedsFrequencyCap(n)) {
    return { ok: false, reason: `frequency_cap (${n} outbound calls in window)` };
  }
  return { ok: true, reason: "ok" };
}
