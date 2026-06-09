import { eq } from "drizzle-orm";
import { db, leadsTable } from "@workspace/db";
import { normalizePhone, phoneLookupVariants } from "./phone";

export async function findLeadByPhone(raw: string) {
  const variants = phoneLookupVariants(raw);
  for (const phone of variants) {
    const [found] = await db.select().from(leadsTable).where(eq(leadsTable.phone, phone));
    if (found) return found;
  }
  return null;
}

export async function findOrCreateLead(
  raw: string,
  opts: { name?: string; source?: string } = {},
) {
  const normalized = normalizePhone(raw);
  if (!normalized) return null;

  const existing = await findLeadByPhone(normalized);
  if (existing) return existing;

  // NOTE: leads.phone is intentionally NOT a unique constraint (phone formats
  // aren't fully normalised across legacy rows), so we cannot use
  // onConflictDoUpdate here. The findLeadByPhone() check above dedupes the
  // common case; a tiny concurrent-insert race is acceptable and self-heals on
  // the next lookup.
  const [lead] = await db
    .insert(leadsTable)
    .values({
      name: opts.name?.trim() || "",
      phone: normalized,
      status: "new",
      score: 0,
      source: opts.source ?? null,
    })
    .returning();

  return lead ?? null;
}
