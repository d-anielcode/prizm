# Kalshi Book-Price Scanner + Paper Trading — Design

Date: 2026-10-21 · Status: approved in brainstorming, pending spec review

## Why

The 2025-26 post-season analysis (86.6k graded props, 133k book quotes, ROI at real
odds, time-split validation) found:

- Prizm's confidence score adds ~nothing beyond the sportsbook price
  (market AUC 0.568 vs our score 0.549; adding the score doesn't improve held-out log loss).
- Current LOCK/PLAY tiers lose ~5–6% at real odds on held-out months.
- The only consistent lever is **price**: the same line at a better price is worth
  ~1.5–2 ROI points; lines that disagree with consensus hit more often.

The user bets on **Kalshi**, not sportsbooks. So the goal is profit at Kalshi's
prices, and DraftKings/FanDuel become an *information source*: if Kalshi prices a
rung cheaper than the books' de-vigged probability, after Kalshi's fee, that is an
edge — without relying on Prizm's model.

Kalshi has no usable price history for last season (settled NBA props start
2026-10-05), so the strategy must prove itself forward via paper trading against a
pre-registered bar.

## Goal / success

Ship a scanner that, each game day, finds Kalshi NBA player-prop rungs whose ask is
below the books' fair probability by ≥ 3¢ after fees, logs them as paper trades,
grades them from Kalshi settlement, and reports ROI and CLV.

**Go-live bar (pre-registered; decide only when met or clearly failed):**
≥ 300 graded paper trades AND ROI after fees ≥ +3% AND ROI positive in both the
first and second half (by date) AND mean CLV > 0. Below the bar: stays paper-only;
no re-tuning of thresholds on the same sample.

Out of scope: placing orders, Kalshi RSA auth, position sizing/Kelly, parlays, UI.

## Architecture

Python, extending `scripts/kalshi_edges/` (existing, read-only edge finder from June).
Units, each testable on its own:

| Module | Responsibility | Depends on |
|---|---|---|
| `fair_value.py` (new) | De-vig book prices → fair P(over line) per player/stat | `props` rows |
| `prob_model.py` (existing) | Per-player distribution; `solve_shift`, `prob_at_strike` | game logs |
| `market_data.py` (update) | Fetch + parse Kalshi markets from the 7 stat series | Kalshi public API |
| `fees.py` (new) | Kalshi taker fee for a price, using the series' `fee_multiplier` | — |
| `scanner.py` (new) | Join book fair value ↔ Kalshi rungs, compute YES/NO edge, apply filters | all above |
| `ledger.py` (new) | Insert paper trades; grade settled ones; CLV; report | Supabase REST, Kalshi API |
| `run_paper.py` (new) | CLI entry: `scan` / `grade` / `report`; logs to `.logs/` | scanner, ledger |

The June `find_edges.py` (Prizm-model edge finder) stays as is; it gains the fixed
market parser for free.

## Data flow

**1. Fair probability (fair_value.py).** From `props` (today's slate, by
`commence_time`): for each (player, stat), if over and under rows exist **at the same
line**, convert both to implied probability and normalize to sum to 1 (two-sided
de-vig). If both books quote the pair, average their fair probabilities. If only one
side exists (or lines differ), fair P = implied P − 0.024 (half a typical vig),
flagged `devig='one_sided'`. Odds must pass `isSaneOdds` (−500..+500).

**2. Bridge to Kalshi strikes (prob_model.py).** Fit the player's distribution from
`player_game_logs`; `solve_shift(dist, book_line, fair_p_over)`; for each Kalshi rung
"N+", P(yes) = `prob_at_strike(dist, delta, N)`. If `solve_shift` reports `clamped`,
skip the player (unreliable).

**3. Kalshi markets (market_data.py).** Series `KXNBAPTS, KXNBAREB, KXNBAAST,
KXNBA3PT, KXNBABLK, KXNBASTL, KXNBAPRA`, status `open`. Live-verified format
(2026-10-21): ticker `KXNBAPTS-26OCT21PHXPOR-PORDLILLARD0-25`, title
`"Damian Lillard: 25+ points"`, `strike_type='greater'`, `floor_strike=24.5`,
prices as decimal strings `yes_ask_dollars` / `yes_bid_dollars`, `volume_fp`,
`close_time`. Player name = title text before `": "`; strike N = `floor_strike + 0.5`.
Game date + teams from the ticker's second segment (`26OCT21` + away/home codes).

**4. Edge (scanner.py).**
- `fee(p) = 0.07 × fee_multiplier × p × (1 − p)` per contract (series metadata:
  `fee_type='quadratic'`, `fee_multiplier=1` for NBA props as of 2026-10-21).
- YES: `edge = p_yes − yes_ask − fee(yes_ask)`.
- NO: `no_ask = 1 − yes_bid`; `edge = (1 − p_yes) − no_ask − fee(no_ask)`.
- Keep the better side per rung if its edge ≥ `--min-edge` (default 0.03).

**5. Filters (all configurable, defaults pre-registered):** spread `yes_ask − yes_bid
≤ 0.10`; `0.10 ≤ p_yes ≤ 0.90`; `|N − book_line| ≤ 1.5 × dist.sigma`; game not
started (`now < commence_time`); player name matches exactly one Prizm player
(normalized via `normalizePlayerName` rules); one trade per (market ticker, side).

**6. Paper trade (ledger.py).** Insert into `kalshi_paper_trades` (one row per
flagged rung): 1 contract at the ask seen. Unique on `(market_ticker, side,
scan_date)` so a re-scan never duplicates.

**7. Grading (ledger.py, next morning).** For ungraded rows, fetch the Kalshi market;
if `status` is settled, `won = (result == side)`, `pnl = (1 − price − fee)` if won
else `−(price + fee)`.

**CLV.** A `clv` step runs repeatedly before tips; for each row whose game starts
within the next 30 minutes and has no `clv_mid` yet, it stores the side's current
mid price (YES: `(yes_bid + yes_ask)/2`; NO: `1 − that`). CLV per trade =
`clv_mid − price` (positive = the market moved toward us after entry).

**8. Report.** `run_paper.py report`: n, win rate, ROI after fees, ROI by half, mean
CLV, by stat and side, and a pass/fail line against the go-live bar.

## Ledger table (Supabase, DDL via SQL editor — project rule, never REST)

Migration `supabase/migrations/20261021120000_kalshi_paper_trades.sql`:

```sql
CREATE TABLE IF NOT EXISTS kalshi_paper_trades (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_date     date        NOT NULL,           -- ET date of the scan
  scanned_at    timestamptz NOT NULL DEFAULT now(),
  market_ticker text        NOT NULL,
  series        text        NOT NULL,
  player_name   text        NOT NULL,
  stat_type     text        NOT NULL,
  strike        numeric     NOT NULL,           -- N in "N+"
  side          text        NOT NULL CHECK (side IN ('yes','no')),
  price         numeric     NOT NULL,           -- ask paid for the side
  fee           numeric     NOT NULL,
  fair_p        numeric     NOT NULL,           -- model P(side wins)
  edge          numeric     NOT NULL,
  yes_bid       numeric, yes_ask numeric, volume numeric,
  book_line     numeric, book_p_over numeric,
  devig         text        NOT NULL,           -- 'two_sided' | 'one_sided'
  books         text,                           -- e.g. 'DraftKings,FanDuel'
  commence_time timestamptz,
  clv_mid       numeric,                        -- side mid ~15 min before first tip
  result        text,                           -- Kalshi 'yes' | 'no' once settled
  won           boolean,
  pnl           numeric,
  graded_at     timestamptz,
  UNIQUE (market_ticker, side, scan_date)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.kalshi_paper_trades TO service_role;
GRANT SELECT ON public.kalshi_paper_trades TO anon, authenticated;
```

## Scheduling (user's PC, Windows Task Scheduler, `pythonw.exe`, logs to `.logs/`)

- **Prizm Kalshi scan** — daily 3:45 PM PT: `run_paper.py scan` (after the 19:00 UTC
  props refresh, before the first 7 PM ET tips). Skips games already started.
- **Prizm Kalshi CLV** — daily from 3:55 PM PT, repeating every 30 min until
  7:55 PM PT: `run_paper.py clv` fills `clv_mid` for rows tipping within 30 min
  (covers 7:00 PM ET through 10:30 PM ET tips).
- **Prizm Kalshi grade** — daily 9:00 AM PT: `run_paper.py grade`.

Tasks use "start when available", so a sleeping PC catches up (a late scan only
skips started games).

## Error handling

- Kalshi or Supabase request fails → log and exit non-zero for that step; no partial
  inserts of a malformed row (validate before insert).
- Player in Kalshi but not in Prizm slate, ambiguous name, clamped shift, or missing
  logs → skipped, counted in the run summary (not an error).
- Market missing `yes_bid` (no bids) → NO side not computable; YES only.
- Grading: unsettled markets stay ungraded and are retried next run; voided markets
  (`result` not yes/no) → `won=null, pnl=0`, excluded from ROI.

## Testing

pytest in `scripts/tests/` (existing `test_kalshi_*` pattern):
- `fair_value`: two-sided de-vig sums to 1; book averaging; one-sided fallback flag;
  insane odds rejected.
- `fees`: 0.07·p(1−p) values (e.g. 0.50 → 0.0175), multiplier applied.
- `market_data`: parse the live-verified titles/tickers above as fixtures (player,
  stat, strike, game date, teams).
- `scanner`: YES and NO edge math incl. fee; each filter excludes what it should.
- `ledger`: grade won/lost/void P&L; report math (ROI, halves, CLV, bar pass/fail).
- Smoke: `run_paper.py scan --dry-run` against tonight's live board prints flagged
  rungs without writing.

## Rollout

1. Merge code + migration file; user pastes the migration into the Supabase SQL editor.
2. Dry-run scan on a live slate; review flags by eye.
3. Enable the three scheduled tasks.
4. Weekly: `run_paper.py report`. Decide go-live only against the bar above.
