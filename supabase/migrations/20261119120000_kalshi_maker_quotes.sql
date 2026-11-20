-- Kalshi maker (limit-order) forward paper test (spec 2026-11-19).
-- One row per simulated resting bid: (ticker, side) is unique, posted once, held to tip.
-- Posted by scripts/kalshi_maker_post.py (kalshi_live); scored by scripts/kalshi_maker_settle.py (overnight).
-- New tables on this project get no API grants by default, so grants are explicit.
CREATE TABLE IF NOT EXISTS kalshi_maker_quotes (
  id           bigserial PRIMARY KEY,
  ticker       text NOT NULL,
  market       text NOT NULL CHECK (market IN ('props', 'totals')),
  side         text NOT NULL CHECK (side IN ('yes', 'no')),
  price        numeric NOT NULL,        -- our bid on that side, dollars
  queue_ahead  numeric NOT NULL,        -- contracts resting at our price when posted
  posted_at    timestamptz NOT NULL,
  tip_time     timestamptz NOT NULL,
  game_date    date NOT NULL,           -- ET game date from the ticker
  filled       boolean,                 -- null until scored
  fill_ts      timestamptz,
  result       text,                    -- yes / no / void
  fee          numeric,                 -- maker fee per contract, filled orders only
  pnl          numeric,                 -- per contract, filled orders only
  scored_at    timestamptz,
  UNIQUE (ticker, side)
);
CREATE INDEX IF NOT EXISTS kalshi_maker_quotes_unscored_idx ON kalshi_maker_quotes (tip_time) WHERE scored_at IS NULL;
GRANT SELECT, INSERT, UPDATE, DELETE ON kalshi_maker_quotes TO service_role;
GRANT USAGE, SELECT ON SEQUENCE kalshi_maker_quotes_id_seq TO service_role;
GRANT SELECT ON kalshi_maker_quotes TO anon, authenticated;
ALTER TABLE kalshi_maker_quotes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_read" ON kalshi_maker_quotes;
CREATE POLICY "anon_read" ON kalshi_maker_quotes FOR SELECT TO anon, authenticated USING (true);
