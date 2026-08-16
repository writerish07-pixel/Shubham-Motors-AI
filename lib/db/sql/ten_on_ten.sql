/**
 * Additive columns for Sakshi 10/10 (Customer 360 + call quality).
 * Safe to re-run. Apply on RDS:
 *   psql "$DATABASE_URL" -f lib/db/sql/ten_on_ten.sql
 * or: pnpm --filter @workspace/db run push
 */
ALTER TABLE leads ADD COLUMN IF NOT EXISTS locality text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS previous_vehicle text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS exchange_vehicle text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS objections text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS promises text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS csat_score integer;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_csat_at timestamptz;

ALTER TABLE calls ADD COLUMN IF NOT EXISTS greeting_played boolean;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS avg_turn_ms integer;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS barge_in_count integer;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS cost_per_min_inr integer;
