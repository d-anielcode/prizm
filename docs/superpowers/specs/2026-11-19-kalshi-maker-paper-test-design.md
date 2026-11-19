# Kalshi maker (limit-order) forward paper test — design

Date: 2026-11-19. Status: approved design, not built.
Paper only: **no real or demo orders are ever placed.** Every Kalshi call is a public read.

## Why

The exploratory study (`docs/kalshi-study/2026-11-19-high-prob-rungs-parlays-totals.md`)
found that buying at the ask loses money everywhere, but makers who were filled at
60–90¢ in the last 3 h before tip made money on real fills:

- game totals: +4.4% (p=0.01, 243 days)
- props: +2.5% / +3.6%

Two problems with that result:

- It looked at many cuts, so it may be overfit.
- It scored the fills that existing makers got. A new order joins the back of the
  queue, and those fills are worse.

This test checks the edge going forward, with a queue-aware fill rule and pass
bars fixed before any data comes in.

## Hypotheses (pre-registered)

- **H1 (primary), game totals (KXNBATOTAL):** a one-contract resting bid at the
  best bid, 60–90¢, posted ≤3 h before tip and held to tip, returns > 0 after the
  maker fee on filled orders.
- **H2 (secondary), player props:** the same hypothesis, for the series already in
  `kalshi_ingest`.

Each hypothesis is judged on its own; one passing says nothing about the other.

## 1. Posting (`kalshi_maker_post.py`, PC scheduled task every 15 min, 1pm–11pm PT)

This runs on the user's PC, not GitHub. The GitHub 15-min `kalshi_live` cron
actually fires about twice a day (Nov 2026), which would miss most 3 h pre-tip
windows. Settling stays in the GitHub `overnight` phase, since it runs once a day
and retries itself.

For every open rung, on each side (YES and NO) independently:

**Eligible when:**
- The time to tip is greater than 0 and at most 3 h.
- That side's best bid is in [0.60, 0.90):
  - the YES side's best bid is `yes_bid`;
  - the NO side's best bid is `1 − yes_ask`.
- No order exists yet for (ticker, side).

**Order:**
- One notional contract at that best bid.
- Never repriced or cancelled before tip. The first eligible run decides the price.

**Queue snapshot:**
- `GET /markets/{ticker}/orderbook` is read when the order is posted.
- `queue_ahead` = the contracts resting on our side at our price.
- If the book's best level differs from the market snapshot, use the book's best
  bid on that side. Its depth is `queue_ahead`.

**Tip time:**
- Taken from ESPN's scoreboard (`kalshi_edges.espn.tip_index`, via
  `history.tips_cache`), matched on the ticker's away/home team codes. This is
  the same source the Kalshi backfills use, and it covers both props and totals.
- Rungs with no matched tip are skipped.

**Markets:**
- Props: the series in `INGEST_SERIES_STAT`.
- Totals: KXNBATOTAL open markets, fetched directly. They are not stored in
  `kalshi_markets`.

## 2. Storage

New table `kalshi_maker_quotes`. Migration includes GRANTs, RLS, and an anon_read
policy, per house rules.

| column | type | notes |
|---|---|---|
| id | bigserial pk | |
| ticker | text | |
| market | text | `props` / `totals` |
| side | text | `yes` / `no` |
| price | numeric | our bid on that side, dollars |
| queue_ahead | numeric | contracts ahead at our price when posted |
| posted_at | timestamptz | |
| tip_time | timestamptz | |
| game_date | date | ET |
| filled | boolean null | null until scored |
| fill_ts | timestamptz null | |
| result | text null | `yes`/`no`/`void` |
| fee | numeric null | 0.0175·p·(1−p) |
| pnl | numeric null | per contract |
| scored_at | timestamptz null | |

Unique key: (ticker, side). The insert uses on-conflict-do-nothing, so overlapping
cron runs are safe.

## 3. Fill rule (pure function, applied after tip)

Inputs:
- the order;
- every non-block trade on that ticker with `posted_at < created_time ≤ tip_time`,
  from `/markets/trades`, with `/historical/trades` as a fallback.

Trades are walked oldest first, with `remaining = queue_ahead`. A trade *hits our
side* when the taker sold into it:

- **Our side is YES at price p:**
  - a hit is `taker_side == "no"`;
  - its price is `yes_price`.
- **Our side is NO at price q:**
  - a hit is `taker_side == "yes"`;
  - its price is `1 − yes_price`.

For each hit:
- **Price below our price:** the taker went through our level, so we are filled at
  our price.
- **Price equal to our price:**
  1. `remaining -= count`.
  2. If `remaining < 0`, we are filled.
- **Price above our price:** ignored. It filled better-priced bids ahead of us.

Trades on the other side are ignored.

If no fill happens by tip, `filled = false`: there is no position and no P&L.

Cancellations ahead of us are invisible, so we treat them as never happening. That
undercounts our fills, which is the safe direction.

## 4. Scoring (step `kalshi_maker_settle`, in `overnight`, after `kalshi_settle`)

For each unscored order whose tip was more than 3 h ago:

1. Pull its trades.
2. Apply the fill rule.
3. Read the market's result. If the market isn't settled yet, leave the order for
   the next night.

For filled orders, use the existing `ledger.grade(side, price, fee, result)` with
the maker fee. Scoring is idempotent and only touches rows where `scored_at` is null.

**Failures:**
- A trade pull that is rate-limited or incomplete leaves the row unscored.
- After 7 days unscored, the order is marked `void` and counted in the report.

## 5. Pre-registered bar (constants in code: `MAKER_BAR`)

Each hypothesis passes only if all of these hold on its filled orders:

- n_filled ≥ 300
- ROI (P&L / (price + fee)) ≥ +2%
- ROI > 0 in both chronological halves
- day-clustered one-sided t-test on per-day mean P&L: p < 0.025
  (0.05 Bonferroni-split across H1/H2)

**End point:**
- The test stops at the end of the 2026-27 regular season, fixed as 2027-04-11.
- It stops earlier for a hypothesis once that hypothesis reaches n_filled ≥ 300.
  At that point the full report runs once.
- **Sample when it stops early:** every filled order on game dates up to and
  including the date of the 300th fill, ordered by tip time.
- **Sample at the season end:** every filled order with game_date ≤ 2027-04-11.

**No peeking:**
- Before the end point, the report shows only counts and the fill rate, never ROI.
- The thresholds, window, price band and fill rule are not tuned during the test.
  A change means a new test with a new start date.

**After the test:**
- **Pass:** that justifies discussing a tiny live test (the user's decision and the
  user's orders).
- **Fail:** it ends the maker hypothesis for that market.

## 6. Report (`scripts/kalshi_maker_report.py`)

- **Default:** per market, the number of orders, the number scored, fill rate,
  median queue_ahead, and void count.
- **`--final`:** adds ROI, the halves, the p-value and pass/fail. It refuses to run
  before the end point unless `--force` is passed. `--force` prints a warning
  banner that the result is not pre-registered.

## 7. Code layout

- `scripts/kalshi_edges/maker_quotes.py`, pure functions:
  - `eligible_sides(market, now, tip)`
  - `queue_ahead(orderbook, side, price)`
  - `fill(order, trades)`
  - `score(order, trades, result)`
  - `bar_check(rows)`
  - Supabase I/O kept in thin wrappers.
- `scripts/kalshi_maker_post.py`, `scripts/kalshi_maker_settle.py`: entry points.
- `scripts/pipeline/phases.py`: add the two steps (non-critical, same `kalshi` group).
- `scripts/kalshi_maker_report.py`
- `supabase/migrations/2026111912xxxx_kalshi_maker_quotes.sql`
- Tests in `scripts/tests/test_kalshi_maker_quotes.py`:
  - eligibility edges: 0.60 in, 0.90 out, 3 h boundary, past tip
  - queue depth parsing for YES and NO books
  - fill cases:
    - through-price fill
    - queue used up exactly vs. not used up
    - wrong-side trades ignored
    - better-priced trades ignored
    - trades before posting or after tip ignored
  - void and unsettled results
  - bar math: halves, day clustering, n threshold

## Out of scope

- Any real or demo order.
- UI.
- Repricing or cancel logic.
- Sizes other than one contract.
- Combos.
- Using the model to choose which side to quote.

Each of these would be a separate, later test.
