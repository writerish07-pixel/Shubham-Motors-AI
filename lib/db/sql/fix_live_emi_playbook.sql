/**
 * Replace the leftover "EMI without math" Knowledge Base playbook with Live EMI.
 * Safe to re-run. Apply on RDS (CloudShell):
 *   psql "$DATABASE_URL" -f lib/db/sql/fix_live_emi_playbook.sql
 *
 * The CRM Playbook tab reads this table. The live EMI engine is already in the
 * API; this only rewrites the stale seed card.
 */
UPDATE knowledge
SET title = 'Live EMI',
    content = 'EMI live reducing-balance se nikalti hai. [EMI:Model|down|months] tag lagao — server hisaab karta hai. Customer ka down payment repeat karo. CIBIL 8.5–12% band batao. Exact lock → [TRANSFER:FINANCE]. Table se mat padho.',
    is_active = true,
    requires_review = false,
    source = COALESCE(NULLIF(source, ''), 'sakshi-playbook'),
    updated_at = NOW()
WHERE category = 'playbook'
  AND (
    title ILIKE '%EMI without math%'
    OR content ILIKE '%PRECOMPUTED EMI%'
    OR content ILIKE '%Kabhi calculate mat karo%'
  );

DELETE FROM knowledge a
USING knowledge b
WHERE a.category = 'playbook'
  AND b.category = 'playbook'
  AND a.title = 'Live EMI'
  AND b.title = 'Live EMI'
  AND a.id > b.id;
