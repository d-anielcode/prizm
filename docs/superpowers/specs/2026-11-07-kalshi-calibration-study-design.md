# Prediction Markets phase 2a: Kalshi calibration study

Date: 2026-11-07. Status: approved design, pending implementation plan.
Builds on: `2026-11-06-prediction-markets-mode-phase1-design.md`.

## Goal

Find out, before building any player model, whether Kalshi's own pre-tip prices on
NBA player props are miscalibrated anywhere (long-shot rungs, DD/TD, ladder ends,
wide books, thin books). Measure it on every settled market back to Nov 2025 against
a bar written down here before any result is seen. Pockets that pass are
paper-traded forward automatically; the Edge tab shows the evidence. Nothing is
labeled a bet until the forward record passes.

## Why this first

- The sportsbook model scored about the same as the market (AUC 0.549 vs 0.568), and
  the book-anchored Kalshi paper scanner stood at 147 trades, ROI -13.6%, CLV -0.9c
  on 2026-11-06. A new player model is the weakest bet.
- Kalshi exposes the data to test pricing directly (verified 2026-11-07):
  - `/historical/markets?series_ticker=KXNBAPTS`: 23,562 settled points markets,
    2025-11-19 to 2026-06-14 (historical cutoff 2026-09-07).
  - `/markets?status=settled`: 6,385 points markets so far in 2026-27.
  - `/series/{s}/markets/{t}/candlesticks?period_interval=60`: hourly yes bid/ask
    close, trade price, volume. Pre-cutoff markets may need the historical
    candlestick route; the plan verifies which.
- Some rungs open mid-game (e.g. opened 9:11 PM ET, closed 11:03 PM ET). They are
  excluded by the pre-tip filter below.

Phase 2b (game-log player model incl. a joint DD/TD model) is a separate spec,
written only if this study shows where a model could add something.

## Data

### Table `kalshi_settled` (one row per settled market priced before tip)

| column | type | notes |
|---|---|---|
| ticker | text PK | |
| series, stat, player, strike | | as in `kalshi_markets` |
| game_date | date | from the ticker |
| away, home | text | Kalshi codes |
| season | text | '2025-26' or '2026-27' (game_date before / from 2026-10-01) |
| tip_time | timestamptz | ESPN scheduled start |
| open_time | timestamptz | Kalshi |
| pretip_yes_bid, pretip_yes_ask | numeric | close of the last hourly candle ending at or before tip; null if that side is empty (bid 0, ask 0 or >= 1) |
| pretip_volume | numeric | contracts traded before tip |
| result | text | 'yes' / 'no' / 'void' |
| backfilled_at | timestamptz | default now() |

Index on `game_date`. RLS on, `anon_read` select policy, and explicit grants
(`service_role` select/insert/update/delete, `anon`/`authenticated` select): new
tables on this project get no API grants by default.

Rows are skipped (counted, not stored) when the market opened after tip, has no
candle before tip, has no tip time match, or is not one of the 7 phase-1 series.

### Tip times

ESPN scoreboard `site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=YYYYMMDD`
for each game date (the ET date in the ticker), matched by away/home team after
normalizing both sides' codes (GS/GSW, NO/NOP, NY/NYK, SA/SAS, UTAH/UTA, WSH/WAS,
and any Kalshi variants found during the backfill). Cached per date.

### Backfill

`scripts/kalshi_edges/history.py` + entry `scripts/kalshi_backfill.py`, run once on
the PC:

1. List settled markets per series from the historical and live endpoints.
2. Group by game; fetch ESPN tip times per date.
3. For each market opened before tip, fetch hourly candles from open to tip and
   take the pre-tip values.
4. Upsert to `kalshi_settled` in pages of 500.

Resumable: skips tickers already in the table. Throttled to about 8 requests a
second with the existing 429 retry/backoff. Expected about 100k candle calls, a few
hours once; the plan checks for a batch candle endpoint first.

### Ongoing

The overnight `kalshi_settle` step also builds `kalshi_settled` rows for the dates
it settles (same code path as the backfill), so the confirmation sample grows nightly.

## Study (pre-registered)

`scripts/kalshi_study.py` reads `kalshi_settled` and writes a report and the
`kalshi_pockets` table.

### Trades

Each priced side of each settled non-void market is one hypothetical 1-contract trade:

- buy YES at `pretip_yes_ask`; wins if result = yes;
- buy NO at `1 - pretip_yes_bid`; wins if result = no.

Price must be in [0.02, 0.98]. Fee per contract `0.07 p (1-p)` (`fees.taker_fee`,
unrounded, as for 10+ contract orders). P&L: win `1 - p - fee`, loss `-(p + fee)`.
ROI = total P&L / total (p + fee).

### Pockets (fixed list, K = 176)

Single-dimension slices for each side (2 x 25 = 50):

- price band of the side's cost (9): [.02,.05) [.05,.10) [.10,.20) [.20,.35)
  [.35,.50) [.50,.65) [.65,.80) [.80,.90) [.90,.98]
- stat (7): points, rebounds, assists, three_pointers, pra, double_double, triple_double
- rung position (3): lowest, interior, top of the player-stat-game ladder among
  pre-tip-priced rungs; DD/TD and one-rung ladders count as lowest
- spread (3): <= 3c, 4-10c, > 10c (YES ask minus bid; one-sided books count as > 10c)
- pre-tip volume (3): 0, 1-99, 100+ contracts

Plus side x price band x stat (2 x 9 x 7 = 126).

No pockets are added after results are seen. Any later idea is a new spec with a
new forward test.

### Bars

- **Discovery (season 2025-26):** n >= 300 trades, ROI >= +3%, ROI > 0 in both
  chronological halves, and one-sided p < 0.05 / 176 from a t-test on per-day
  summed P&L (days, not trades, are the sample, because rungs in one game move
  together).
- **Confirmation (season 2026-27 to date):** once n >= 100, ROI >= 0. Below 100 the
  pocket waits ("confirming").
- **Forward:** confirmed pockets are paper-traded (below). A pocket is "live" at
  >= 300 forward trades with ROI >= +3%.

Statuses: `rejected`, `discovery_pass` (waiting on confirmation n), `confirmed`
(forward trading), `failed_confirmation`, `failed_forward`, `live`.

### Output

- `kalshi_pockets` table: id (e.g. `no|band:.05-.10`, `yes|band:.10-.20|stat:pra`),
  side, definition (jsonb), discovery n/roi/roi halves/p, confirmation n/roi,
  forward n/roi, status, updated_at. Same RLS/grants pattern.
- Calibration table for the chart, stored in the same report JSON: per season and
  YES-ask band, n, mean ask, realized YES rate.
- Report `docs/kalshi-study/<date>-calibration.md` + `.json`, committed, with the
  full pocket table, so the numbers are on record whatever they show.

The study reruns weekly (pipeline `weekly` phase, step `kalshi_study`, chain
'kalshi') to update confirmation counts. The discovery numbers never change after
the first run (2025-26 is closed).

## Forward paper trading

- New pretip step `kalshi_pocket_scan` (chain 'kalshi', after `kalshi_ingest`):
  for games tipping within the next 45 minutes, every `kalshi_markets` rung whose
  side/price/stat/position/spread/volume puts it in a `confirmed` or `live`
  pocket is logged to `kalshi_pocket_trades` once per (pocket, ticker, side),
  at the current ask (YES) or 1 - bid (NO), with the fee.
- Overnight step `kalshi_pocket_grade` (after `kalshi_settle`) grades open trades
  from `kalshi_markets.result`; void trades are graded void with P&L 0.
- `kalshi_pocket_trades`: id, pocket_id, ticker, side, price, fee, game_date,
  logged_at, result, won, pnl. Unique (pocket_id, ticker, side). Same RLS/grants.
- Tip times for live games come from the ESPN scoreboard (same helper).

Pocket assignment for a live rung uses the same classifier as the study
(`classify(trade) -> list[pocket_id]`), so study and forward test cannot drift.
Spread, volume and ladder position for live rungs come from `kalshi_markets`
(volume there is the market's running total, equivalent to pre-tip volume).

## App: `/markets/edge`

Replaces the placeholder. Three sections, facts only:

1. **Calibration chart:** YES-ask band (x) vs realized YES rate (y), one series per
   season, diagonal = perfectly priced, point labels with n. Inline SVG, no new
   chart library.
2. **Pockets:** every pocket that is not `rejected`, with discovery ROI/n,
   confirmation ROI/n, forward ROI/n, and status. A count line for rejected
   pockets ("170 of 176 tested pockets rejected").
3. **Today's paper rungs:** today's `kalshi_markets` rungs that fall in confirmed
   or live pockets, labeled "paper", with the pocket name. Empty state says no
   pocket has confirmed yet.

No bet labels in this phase, including for `live` pockets. Turning a live pocket
into a recommendation is a later, explicit decision.

## Error handling

- Backfill: per-market failures are logged and counted; rerunning resumes. A run
  that skips more than 20% of a series for "no tip time match" stops and reports,
  since that means team-code mapping is wrong.
- Study: refuses to write pockets if `kalshi_settled` has fewer than 1,000 rows
  for 2025-26 (backfill incomplete).
- Pocket scan / grade: non-critical pipeline steps on the 'kalshi' chain; failures
  show on `/status`.

## Testing

- Pytest:
  - pre-tip candle selection, including markets opened after tip and one-sided
    books;
  - team-code normalization for the ESPN match;
  - trade construction and fee/P&L/ROI;
  - pocket classification for each dimension;
  - ladder position;
  - bar logic (discovery, confirmation, forward, statuses);
  - day-clustered t-test against a known example;
  - pocket scan's 45-minute window and dedupe;
  - grading, including void.
- Vitest: Edge tab helpers (chart scaling, pocket row formatting).
- A dry run of the study on a small fixture before the full backfill.

## Success criteria

- `kalshi_settled` holds the 2025-26 and 2026-27 settled markets for all 7 series,
  with fewer than 20% skipped for tip-time reasons.
- The study report is committed with all 176 pockets and the calibration table.
- Confirmed pockets (if any) start logging forward paper trades at the next pretip
  run, and `/markets/edge` shows the chart, pocket table, and today's paper rungs.
- If no pocket passes, the report says so plainly and the Edge tab shows the
  calibration chart and "no pocket passed"; phase 2b is then reconsidered.
