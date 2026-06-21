-- Migration: add L15 rank columns + pace to team_defense_stats,
-- and create team_defense_vs_position table for per-position DVP.

-- Step 1: Add L15 defensive rank columns and pace to existing team_defense_stats table
ALTER TABLE team_defense_stats
  ADD COLUMN IF NOT EXISTS pts_rank_l15  integer,
  ADD COLUMN IF NOT EXISTS reb_rank_l15  integer,
  ADD COLUMN IF NOT EXISTS ast_rank_l15  integer,
  ADD COLUMN IF NOT EXISTS blk_rank_l15  integer,
  ADD COLUMN IF NOT EXISTS stl_rank_l15  integer,
  ADD COLUMN IF NOT EXISTS fg3m_rank_l15 integer,
  ADD COLUMN IF NOT EXISTS pace          numeric(6,2);

-- Step 2: Create team_defense_vs_position table
-- Stores per-team defensive ranks broken down by opposing player position group.
-- position_group: 'guard' | 'forward' | 'center'
-- Ranks: 1 = best defense (fewest given up), 30 = worst defense
CREATE TABLE IF NOT EXISTS team_defense_vs_position (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_abbreviation  text        NOT NULL,
  position_group     text        NOT NULL CHECK (position_group IN ('guard', 'forward', 'center')),
  pts_rank           integer,
  reb_rank           integer,
  ast_rank           integer,
  blk_rank           integer,
  stl_rank           integer,
  fg3m_rank          integer,
  fetched_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_abbreviation, position_group)
);

-- Step 3: Enable RLS and grant access
ALTER TABLE team_defense_vs_position ENABLE ROW LEVEL SECURITY;

-- Allow service role full access (used by GitHub Actions / cron)
CREATE POLICY "service_role_all" ON team_defense_vs_position
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Allow anon read (used by the Next.js API)
CREATE POLICY "anon_read" ON team_defense_vs_position
  FOR SELECT
  TO anon
  USING (true);
