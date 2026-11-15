-- Full-ladder Kalshi model picks (spec 2026-11-11).
-- kalshi_model_rungs: one row per Kalshi ticker, the sportsbook model stretched to that strike.
-- Written every 15 min by scripts/kalshi_model_rungs.py (service role); read by /markets pages.
-- New tables on this project get no API grants by default, so grants are explicit.
CREATE TABLE IF NOT EXISTS kalshi_model_rungs (
  ticker         text PRIMARY KEY,
  player         text NOT NULL,
  stat           text NOT NULL,
  strike         int  NOT NULL,
  game_date      date NOT NULL,
  model_p        numeric NOT NULL,       -- P(stat >= strike)
  anchor_line    numeric NOT NULL,
  anchor_p       numeric NOT NULL,       -- calibrated P(over anchor_line)
  delta          numeric NOT NULL,       -- mean shift applied to the log distribution
  exact          boolean NOT NULL,       -- a scored book line sits at strike - 0.5
  commence_time  timestamptz,
  computed_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kalshi_model_rungs_game_date_idx ON kalshi_model_rungs (game_date);
GRANT SELECT, INSERT, UPDATE, DELETE ON kalshi_model_rungs TO service_role;
GRANT SELECT ON kalshi_model_rungs TO anon, authenticated;
ALTER TABLE kalshi_model_rungs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_read" ON kalshi_model_rungs;
CREATE POLICY "anon_read" ON kalshi_model_rungs FOR SELECT TO anon, authenticated USING (true);

-- Exact-line picks vs stretched picks share one ledger.
ALTER TABLE kalshi_model_picks ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'exact';
