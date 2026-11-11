-- Kalshi paper-trade ledger (spec 2026-10-21-kalshi-book-price-scanner-design).
-- Additive; no existing table touched. Apply in the Supabase SQL editor.
CREATE TABLE IF NOT EXISTS kalshi_paper_trades (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_date     date        NOT NULL,
  scanned_at    timestamptz NOT NULL DEFAULT now(),
  market_ticker text        NOT NULL,
  series        text        NOT NULL,
  player_name   text        NOT NULL,
  stat_type     text        NOT NULL,
  strike        numeric     NOT NULL,
  side          text        NOT NULL CHECK (side IN ('yes','no')),
  price         numeric     NOT NULL,
  fee           numeric     NOT NULL,
  fair_p        numeric     NOT NULL,
  edge          numeric     NOT NULL,
  yes_bid       numeric,
  yes_ask       numeric,
  volume        numeric,
  book_line     numeric,
  book_p_over   numeric,
  devig         text        NOT NULL,
  books         text,
  commence_time timestamptz,
  clv_mid       numeric,
  result        text,
  won           boolean,
  pnl           numeric,
  graded_at     timestamptz,
  UNIQUE (market_ticker, side, scan_date)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.kalshi_paper_trades TO service_role;
GRANT SELECT ON public.kalshi_paper_trades TO anon, authenticated;
