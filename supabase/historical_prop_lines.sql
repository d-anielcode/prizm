-- Run once in Supabase SQL Editor
-- Stores the actual prop lines posted by sportsbooks for each game in the past.
-- Used by the confidence model to compute accurate hit rates vs real market lines
-- instead of retroactively applying tonight's line to historical games.

CREATE TABLE IF NOT EXISTS historical_prop_lines (
  id             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  game_date      date        NOT NULL,
  game_id        text        NOT NULL,  -- The Odds API event ID
  player_name    text        NOT NULL,
  stat_type      text        NOT NULL,
  direction      text        NOT NULL CHECK (direction IN ('over', 'under')),
  line           numeric     NOT NULL,
  odds           integer,
  sportsbook     text,
  home_team      text,
  away_team      text,
  commence_time  timestamptz,
  fetched_at     timestamptz DEFAULT now(),
  UNIQUE (game_date, player_name, stat_type, direction, sportsbook)
);

CREATE INDEX IF NOT EXISTS idx_hist_props_player_stat
  ON historical_prop_lines (player_name, stat_type, game_date DESC);

CREATE INDEX IF NOT EXISTS idx_hist_props_game_date
  ON historical_prop_lines (game_date DESC);

-- RLS
ALTER TABLE historical_prop_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read historical_prop_lines"
  ON historical_prop_lines FOR SELECT USING (true);
CREATE POLICY "Service role can write historical_prop_lines"
  ON historical_prop_lines FOR ALL USING (true);

GRANT ALL   ON TABLE historical_prop_lines TO service_role;
GRANT SELECT ON TABLE historical_prop_lines TO anon, authenticated;
