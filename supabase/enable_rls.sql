-- enable_rls.sql
-- Run once in Supabase SQL Editor: Dashboard → SQL Editor → New Query
--
-- Enables Row Level Security on all app tables and sets safe policies:
--   • anon / authenticated users → SELECT only (public read)
--   • service_role → full access (INSERT, UPDATE, DELETE via server-side API routes)
--   • service_role bypasses RLS by default in Supabase, so write policies are implicit
--
-- Also fixes existing over-broad policies that accidentally allow anon writes.

-- ─────────────────────────────────────────────────────────────────────────────
-- HELPER: drop a policy only if it exists (avoids errors on re-runs)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. props ─────────────────────────────────────────────────────────────────
ALTER TABLE props ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read"  ON props;
DROP POLICY IF EXISTS "Anyone can read props" ON props;
CREATE POLICY "anon_read" ON props FOR SELECT TO anon, authenticated USING (true);

-- ── 2. curated_parlays ───────────────────────────────────────────────────────
ALTER TABLE curated_parlays ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read" ON curated_parlays;
DROP POLICY IF EXISTS "Anyone can read curated_parlays" ON curated_parlays;
CREATE POLICY "anon_read" ON curated_parlays FOR SELECT TO anon, authenticated USING (true);

-- ── 3. games ─────────────────────────────────────────────────────────────────
ALTER TABLE games ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read" ON games;
CREATE POLICY "anon_read" ON games FOR SELECT TO anon, authenticated USING (true);

-- ── 4. player_game_logs ──────────────────────────────────────────────────────
ALTER TABLE player_game_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read" ON player_game_logs;
CREATE POLICY "anon_read" ON player_game_logs FOR SELECT TO anon, authenticated USING (true);

-- ── 5. player_season_stats ───────────────────────────────────────────────────
ALTER TABLE player_season_stats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read" ON player_season_stats;
CREATE POLICY "anon_read" ON player_season_stats FOR SELECT TO anon, authenticated USING (true);

-- ── 6. team_defense_stats ────────────────────────────────────────────────────
ALTER TABLE team_defense_stats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read" ON team_defense_stats;
CREATE POLICY "anon_read" ON team_defense_stats FOR SELECT TO anon, authenticated USING (true);

-- ── 7. prop_results ──────────────────────────────────────────────────────────
ALTER TABLE prop_results ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read" ON prop_results;
CREATE POLICY "anon_read" ON prop_results FOR SELECT TO anon, authenticated USING (true);

-- ── 8. prop_history ──────────────────────────────────────────────────────────
ALTER TABLE prop_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read" ON prop_history;
CREATE POLICY "anon_read" ON prop_history FOR SELECT TO anon, authenticated USING (true);

-- ── 9. prop_alts ─────────────────────────────────────────────────────────────
ALTER TABLE IF EXISTS prop_alts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read" ON prop_alts;
CREATE POLICY "anon_read" ON prop_alts FOR SELECT TO anon, authenticated USING (true);

-- ── 10. opponent_stat_leaks ───────────────────────────────────────────────────
ALTER TABLE IF EXISTS opponent_stat_leaks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read" ON opponent_stat_leaks;
CREATE POLICY "anon_read" ON opponent_stat_leaks FOR SELECT TO anon, authenticated USING (true);

-- ── 11. performance_snapshot ──────────────────────────────────────────────────
ALTER TABLE IF EXISTS performance_snapshot ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read" ON performance_snapshot;
CREATE POLICY "anon_read" ON performance_snapshot FOR SELECT TO anon, authenticated USING (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- FIX: existing over-broad write policies (no role specified = applies to anon)
-- These tables already have RLS but the write policy allows anyone to write.
-- Drop and recreate scoped to service_role only.
-- (service_role bypasses RLS by default in Supabase, so the policy is optional
--  but explicit is better for auditability.)
-- ─────────────────────────────────────────────────────────────────────────────

-- prop_grades
DROP POLICY IF EXISTS "Service role can write prop_grades"    ON prop_grades;
DROP POLICY IF EXISTS "service_write"                         ON prop_grades;
CREATE POLICY "service_write" ON prop_grades FOR ALL TO service_role USING (true) WITH CHECK (true);

-- historical_prop_lines
DROP POLICY IF EXISTS "Service role can write historical_prop_lines" ON historical_prop_lines;
DROP POLICY IF EXISTS "service_write"                                ON historical_prop_lines;
CREATE POLICY "service_write" ON historical_prop_lines FOR ALL TO service_role USING (true) WITH CHECK (true);

-- synthetic_prop_lines
DROP POLICY IF EXISTS "Service role can write synthetic_prop_lines" ON synthetic_prop_lines;
DROP POLICY IF EXISTS "service_write"                               ON synthetic_prop_lines;
CREATE POLICY "service_write" ON synthetic_prop_lines FOR ALL TO service_role USING (true) WITH CHECK (true);

-- player_line_bias
DROP POLICY IF EXISTS "Service role can write player_line_bias" ON player_line_bias;
DROP POLICY IF EXISTS "service_write"                           ON player_line_bias;
CREATE POLICY "service_write" ON player_line_bias FOR ALL TO service_role USING (true) WITH CHECK (true);

-- team_defense_vs_position (already correct name, just ensure it exists)
DROP POLICY IF EXISTS "service_role_all" ON team_defense_vs_position;
CREATE POLICY "service_write" ON team_defense_vs_position FOR ALL TO service_role USING (true) WITH CHECK (true);

-- player_positions (already correct name, just ensure it exists)
DROP POLICY IF EXISTS "service_role_all" ON player_positions;
CREATE POLICY "service_write" ON player_positions FOR ALL TO service_role USING (true) WITH CHECK (true);
