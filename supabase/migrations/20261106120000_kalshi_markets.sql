-- Kalshi NBA player-prop markets, one row per ticker (Prediction Markets mode, phase 1).
-- Written only by the service role (pipeline steps kalshi_ingest / kalshi_settle);
-- read publicly by /markets pages. Idempotent. Apply in the Supabase SQL editor.
CREATE TABLE IF NOT EXISTS kalshi_markets (
  ticker        text PRIMARY KEY,
  series        text NOT NULL,
  stat          text NOT NULL,      -- points|rebounds|assists|three_pointers|pra|double_double|triple_double
  player        text NOT NULL,      -- as Kalshi spells it
  strike        int  NOT NULL,      -- N in "N+"; 1 for double_double / triple_double
  game_date     date,
  away          text,
  home          text,
  yes_bid       numeric,            -- 0..1, null when no bid
  yes_ask       numeric,            -- 0..1, null when no ask
  first_yes_ask numeric,            -- ask when first seen; kept by trigger
  volume        int  NOT NULL DEFAULT 0,
  status        text,
  result        text,               -- 'yes' / 'no' once finalized
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kalshi_markets_game_date_idx ON kalshi_markets (game_date);

-- Upserts always send first_yes_ask = current ask; keep the first one ever stored.
CREATE OR REPLACE FUNCTION kalshi_markets_keep_first() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.first_yes_ask := COALESCE(OLD.first_yes_ask, NEW.first_yes_ask);
  NEW.first_seen_at := OLD.first_seen_at;
  NEW.updated_at    := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS kalshi_markets_keep_first ON kalshi_markets;
CREATE TRIGGER kalshi_markets_keep_first BEFORE UPDATE ON kalshi_markets
  FOR EACH ROW EXECUTE FUNCTION kalshi_markets_keep_first();

ALTER TABLE kalshi_markets ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON kalshi_markets FROM anon, authenticated;
DROP POLICY IF EXISTS "anon_read" ON kalshi_markets;
CREATE POLICY "anon_read" ON kalshi_markets FOR SELECT TO anon, authenticated USING (true);
