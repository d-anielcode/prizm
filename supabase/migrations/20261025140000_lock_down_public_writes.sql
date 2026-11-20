-- Lock down writes from the public (anon/authenticated) roles.
--
-- 2026-10-25 audit: six tables had RLS off AND anon INSERT/UPDATE/DELETE grants
-- (bankroll_entries, parlays, player_stats, wnba_props, wnba_prop_alts,
-- wnba_prop_history), so anyone with the anon key — which ships in the site's JS —
-- could change or wipe them. Seven more had RLS on but still granted anon writes.
--
-- The app never writes with the anon key: no client component uses Supabase, and
-- every server write uses the service role (which bypasses grants and RLS). So:
--   1. revoke all write privileges from anon/authenticated on every public table,
--      now and for tables created later;
--   2. turn RLS on for the tables that had it off, with a public read policy only
--      where the data is meant to be public (bankroll_entries and system_locks get
--      no public read at all).
-- Idempotent. Apply in the Supabase SQL editor.

-- 1. No public writes, anywhere
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLES FROM anon, authenticated;

-- 2. RLS on everywhere it was off
ALTER TABLE bankroll_entries        ENABLE ROW LEVEL SECURITY;
ALTER TABLE confirmed_lineups       ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_runs                ENABLE ROW LEVEL SECURITY;
ALTER TABLE kalshi_paper_trades     ENABLE ROW LEVEL SECURITY;
ALTER TABLE parlays                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_stats            ENABLE ROW LEVEL SECURITY;
ALTER TABLE prop_features           ENABLE ROW LEVEL SECURITY;
ALTER TABLE sim_3pm                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_locks            ENABLE ROW LEVEL SECURITY;
ALTER TABLE wnba_player_game_logs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE wnba_prop_alts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE wnba_prop_grades        ENABLE ROW LEVEL SECURITY;
ALTER TABLE wnba_prop_history       ENABLE ROW LEVEL SECURITY;
ALTER TABLE wnba_props              ENABLE ROW LEVEL SECURITY;
ALTER TABLE wnba_team_defense_stats ENABLE ROW LEVEL SECURITY;

-- Public read for public data (same as the existing tables' "anon_read" policies)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'confirmed_lineups', 'job_runs', 'kalshi_paper_trades', 'parlays', 'player_stats',
    'prop_features', 'sim_3pm', 'wnba_player_game_logs', 'wnba_prop_alts',
    'wnba_prop_grades', 'wnba_prop_history', 'wnba_props', 'wnba_team_defense_stats'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "anon_read" ON %I', t);
    EXECUTE format('CREATE POLICY "anon_read" ON %I FOR SELECT TO anon, authenticated USING (true)', t);
  END LOOP;
END $$;
