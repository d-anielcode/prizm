-- Prediction Markets phase 2a: Kalshi calibration study tables.
-- Written by the service role (backfill, study, pocket scan/grade); read publicly by /markets/edge.
-- New tables on this project get no API grants by default, so grants are explicit.

CREATE TABLE IF NOT EXISTS kalshi_settled (
  ticker          text PRIMARY KEY,
  series          text NOT NULL,
  stat            text NOT NULL,
  player          text NOT NULL,
  strike          int  NOT NULL,
  game_date       date NOT NULL,
  away            text,
  home            text,
  season          text NOT NULL,
  tip_time        timestamptz NOT NULL,
  open_time       timestamptz NOT NULL,
  pretip_yes_bid  numeric,
  pretip_yes_ask  numeric,
  pretip_volume   numeric NOT NULL DEFAULT 0,
  result          text NOT NULL,          -- yes | no | void
  backfilled_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kalshi_settled_game_date_idx ON kalshi_settled (game_date);

CREATE TABLE IF NOT EXISTS kalshi_pockets (
  id          text PRIMARY KEY,
  side        text NOT NULL,
  definition  jsonb NOT NULL,
  disc_n      int, disc_roi numeric, disc_roi_h1 numeric, disc_roi_h2 numeric, disc_p numeric,
  conf_n      int, conf_roi numeric,
  fwd_n       int, fwd_roi numeric,
  status      text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kalshi_calibration (
  season     text NOT NULL,
  band       text NOT NULL,
  n          int NOT NULL,
  mean_ask   numeric NOT NULL,
  yes_rate   numeric NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (season, band)
);

CREATE TABLE IF NOT EXISTS kalshi_pocket_trades (
  id         bigserial PRIMARY KEY,
  pocket_id  text NOT NULL,
  ticker     text NOT NULL,
  side       text NOT NULL,
  price      numeric NOT NULL,
  fee        numeric NOT NULL,
  game_date  date NOT NULL,
  logged_at  timestamptz NOT NULL DEFAULT now(),
  result     text,
  won        boolean,
  pnl        numeric,
  UNIQUE (pocket_id, ticker, side)
);
CREATE INDEX IF NOT EXISTS kalshi_pocket_trades_game_date_idx ON kalshi_pocket_trades (game_date);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['kalshi_settled','kalshi_pockets','kalshi_calibration','kalshi_pocket_trades'] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO service_role', t);
    EXECUTE format('GRANT SELECT ON %I TO anon, authenticated', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "anon_read" ON %I', t);
    EXECUTE format('CREATE POLICY "anon_read" ON %I FOR SELECT TO anon, authenticated USING (true)', t);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON SEQUENCE kalshi_pocket_trades_id_seq TO service_role;
