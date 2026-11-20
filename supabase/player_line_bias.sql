-- Run once in Supabase SQL Editor
-- Stores per-player per-stat line bias derived from historical_prop_lines vs actual game logs.
-- A hit_rate significantly above 0.50 means the book systematically underprices this player.
-- Used by the confidence model as a small additive calibration signal.

CREATE TABLE IF NOT EXISTS player_line_bias (
  id             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  player_name    text        NOT NULL,
  stat_type      text        NOT NULL,
  hit_rate       numeric     NOT NULL,  -- fraction of games where actual > line (OVER hit)
  median_ratio   numeric     NOT NULL,  -- median(actual / line) across sampled games
  sample_count   integer     NOT NULL,  -- number of games used
  updated_at     timestamptz DEFAULT now(),
  UNIQUE (player_name, stat_type)
);

CREATE INDEX IF NOT EXISTS idx_player_line_bias_player
  ON player_line_bias (player_name);

-- RLS
ALTER TABLE player_line_bias ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read player_line_bias"
  ON player_line_bias FOR SELECT USING (true);
CREATE POLICY "Service role can write player_line_bias"
  ON player_line_bias FOR ALL USING (true);

GRANT ALL    ON TABLE player_line_bias TO service_role;
GRANT SELECT ON TABLE player_line_bias TO anon, authenticated;
