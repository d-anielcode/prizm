-- Run once in Supabase SQL Editor
-- Stores AI-generated synthetic prop lines for dates before real historical data begins.
-- Used alongside historical_prop_lines to extend the backtest window to Dec 1, 2025.
--
-- Lines are derived from: line = round_to_half(L10_avg * median_ratio)
-- where median_ratio is the calibrated per-stat multiplier from /api/synthetic/analyze.

CREATE TABLE IF NOT EXISTS synthetic_prop_lines (
  id             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  game_date      date        NOT NULL,
  player_name    text        NOT NULL,
  stat_type      text        NOT NULL,
  direction      text        NOT NULL CHECK (direction IN ('over', 'under')),
  line           numeric     NOT NULL,
  home_team      text,
  away_team      text,
  commence_time  timestamptz,
  generated_at   timestamptz DEFAULT now(),
  UNIQUE (game_date, player_name, stat_type, direction)
);

CREATE INDEX IF NOT EXISTS idx_synth_props_player_stat
  ON synthetic_prop_lines (player_name, stat_type, game_date DESC);

CREATE INDEX IF NOT EXISTS idx_synth_props_game_date
  ON synthetic_prop_lines (game_date DESC);

-- RLS
ALTER TABLE synthetic_prop_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read synthetic_prop_lines"
  ON synthetic_prop_lines FOR SELECT USING (true);
CREATE POLICY "Service role can write synthetic_prop_lines"
  ON synthetic_prop_lines FOR ALL USING (true);

GRANT ALL    ON TABLE synthetic_prop_lines TO service_role;
GRANT SELECT ON TABLE synthetic_prop_lines TO anon, authenticated;
