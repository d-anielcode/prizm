-- Run this once in the Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- This fixes "permission denied" errors for prop_history and prop_results tables,
-- and creates prop_grades as the new primary accuracy-tracking table.

-- ── 1. Fix existing tables ────────────────────────────────────────────────────
GRANT ALL ON TABLE prop_history TO postgres, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE prop_history TO authenticated;
GRANT SELECT ON TABLE prop_history TO anon;

GRANT ALL ON TABLE prop_results TO postgres, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE prop_results TO authenticated;
GRANT SELECT ON TABLE prop_results TO anon;

-- ── 2. Create prop_grades — clean accuracy-tracking table ─────────────────────
-- One row per graded prop. Populated nightly by /api/grade cron.
CREATE TABLE IF NOT EXISTS prop_grades (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  game_date        date        NOT NULL,
  player_name      text        NOT NULL,
  stat_type        text        NOT NULL,
  line             numeric     NOT NULL,
  direction        text        NOT NULL,
  confidence_label text,
  confidence_score integer,
  actual_value     numeric,
  hit              boolean,
  graded_at        timestamptz DEFAULT now(),
  UNIQUE (game_date, player_name, stat_type, line, direction)
);

-- RLS
ALTER TABLE prop_grades ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read prop_grades" ON prop_grades FOR SELECT USING (true);
CREATE POLICY "Service role can write prop_grades" ON prop_grades FOR ALL USING (true);

GRANT ALL ON TABLE prop_grades TO postgres, service_role;
GRANT SELECT ON TABLE prop_grades TO anon, authenticated;
