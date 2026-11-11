-- Kalshi model picks: the sportsbook confidence model applied to exact-match Kalshi rungs.
-- Logged by /api/markets/model-picks/log (kalshi_live phase, games tipping within 30 min),
-- graded overnight by scripts/kalshi_model_grade.py. Public read for /markets pages.
CREATE TABLE IF NOT EXISTS kalshi_model_picks (
  id          bigserial PRIMARY KEY,
  ticker      text NOT NULL,
  side        text NOT NULL,          -- yes | no
  player      text NOT NULL,
  stat        text NOT NULL,
  strike      int  NOT NULL,
  game_date   date NOT NULL,
  tier        text NOT NULL,          -- LOCK | PLAY
  model_p     numeric NOT NULL,
  price       numeric NOT NULL,
  fee         numeric NOT NULL,
  edge        numeric NOT NULL,
  logged_at   timestamptz NOT NULL DEFAULT now(),
  result      text,                   -- yes | no | void
  won         boolean,
  pnl         numeric,
  UNIQUE (ticker, side)
);
CREATE INDEX IF NOT EXISTS kalshi_model_picks_game_date_idx ON kalshi_model_picks (game_date);
GRANT SELECT, INSERT, UPDATE, DELETE ON kalshi_model_picks TO service_role;
GRANT USAGE, SELECT ON SEQUENCE kalshi_model_picks_id_seq TO service_role;
GRANT SELECT ON kalshi_model_picks TO anon, authenticated;
ALTER TABLE kalshi_model_picks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_read" ON kalshi_model_picks;
CREATE POLICY "anon_read" ON kalshi_model_picks FOR SELECT TO anon, authenticated USING (true);
