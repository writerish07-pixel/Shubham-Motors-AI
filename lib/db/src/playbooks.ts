/**
 * Sakshi sales playbooks stored in `knowledge` (category = playbook).
 * Seed and the API rewrite stale EMI cards that still say “don’t calculate”.
 */

export const PLAYBOOK_SOURCE = "sakshi-playbook";

export const LIVE_EMI_PLAYBOOK = {
  title: "Live EMI",
  content:
    "EMI live reducing-balance se nikalti hai. [EMI:Model|down|months] tag lagao — server hisaab karta hai. Customer ka down payment repeat karo. CIBIL 8.5–12% band batao. Exact lock → [TRANSFER:FINANCE]. Table se mat padho.",
} as const;

export const PLAYBOOKS: ReadonlyArray<{ title: string; content: string }> = [
  {
    title: "Discovery playbook",
    content:
      "SPIN: Situation pehle memory se (dubara mat poochho). Problem = ek gap (scooter vs bike / km / family). Implication = petrol ya EMI unke number mein. Need-payoff = aaj shaam ya kal subah test ride. 2 signals ke baad recommend karo.",
  },
  {
    title: "Test-ride close",
    content:
      "Price/EMI ke baad seedha slot: 'Aaj 11 baje test ride kar lein ya shaam 4?' Customer haan kahe toh [VISIT] tag. Address: Lal Kothi, Tonk Road, Jaipur. DL saath laana.",
  },
  {
    title: "Soch ke batata hoon",
    content:
      "Stall hai, interest nahi. Ek blocker poochho (budget / family / compare). Phir ek low-commitment next step: test ride ya WhatsApp price. 'Ji bilkul sochiye' mat bolo.",
  },
  LIVE_EMI_PLAYBOOK,
];

/** Old seed card that forbade live math and pointed at a precomputed table. */
export function isStaleEmiPlaybook(title: string, content: string): boolean {
  const t = title.toLowerCase();
  const c = content.toLowerCase();
  if (t.includes("without math")) return true;
  if (c.includes("precomputed emi")) return true;
  if (c.includes("kabhi calculate mat karo")) return true;
  return false;
}

export const REWRITE_STALE_EMI_SQL = `
UPDATE knowledge
SET title = $1,
    content = $2,
    is_active = true,
    requires_review = false,
    source = COALESCE(NULLIF(source, ''), $3),
    updated_at = NOW()
WHERE category = 'playbook'
  AND (
    title ILIKE '%EMI without math%'
    OR content ILIKE '%PRECOMPUTED EMI%'
    OR content ILIKE '%Kabhi calculate mat karo%'
  )
RETURNING id
`.trim();

export const DEDUPE_LIVE_EMI_SQL = `
DELETE FROM knowledge a
USING knowledge b
WHERE a.category = 'playbook'
  AND b.category = 'playbook'
  AND a.title = $1
  AND b.title = $1
  AND a.id > b.id
`.trim();
