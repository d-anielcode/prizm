-- Migration: create player_positions table
-- Stores each player's real NBA position group (guard/forward/center).
-- Populated by /api/defense-stats via leaguedashplayerbiostats endpoint.
-- Used by /api/enrich to replace the inferred stat-based position heuristic.

CREATE TABLE IF NOT EXISTS player_positions (
  player_name     text PRIMARY KEY,
  position_group  text NOT NULL CHECK (position_group IN ('guard', 'forward', 'center')),
  nba_position    text,   -- raw NBA position: 'G', 'F', 'C', 'G-F', 'F-C', 'C-F', 'F-G'
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE player_positions ENABLE ROW LEVEL SECURITY;

-- Service role: full access (GitHub Actions / cron)
CREATE POLICY "service_role_all" ON player_positions
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Anon: read-only (Next.js API)
CREATE POLICY "anon_read" ON player_positions
  FOR SELECT
  TO anon
  USING (true);
