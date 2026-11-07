# Prediction Markets mode, phase 1: Kalshi data + Props tab

Date: 2026-11-06. Status: approved design, pending implementation plan.

## Goal

Add a second mode to Prizm for prediction markets (Kalshi), next to the existing
sportsbook mode, with the same tab set. Kalshi player props are milestone ladders
("N+"): points and PRA step by 5, rebounds and assists by 2, threes by 1, plus
double-double and triple-double contracts. Phase 1 gets Kalshi ladders into the
database on the pipeline and ships a Props tab that shows every rung's price next
to the player's actual hit rate at that rung. No edge claims in this phase.

## Why phased

The full mode splits into independent pieces, each with its own spec:

1. **Kalshi data + mode shell + Props tab** (this spec)
2. Per-rung probability model, including DD/TD (joint distribution), validated on
   settled Kalshi markets before any edge is shown
3. Edge, Feed, Trends, Home tabs in markets mode, built on 1 and 2
4. Grading and Performance from Kalshi settlement
5. Game props (winner, spread, total, team totals)

Context: the existing book-anchored Kalshi paper scanner stood at 147 graded
trades, ROI -13.6%, mean CLV -0.9 cents on 2026-11-06. Kalshi edges are not proven
yet, so phase 1 shows facts (prices, hit rates) only.

## Scope

In: Kalshi series KXNBAPTS, KXNBAREB, KXNBAAST, KXNBA3PT, KXNBAPRA, KXNBA2D,
KXNBA3D. Out: blocks, steals, stocks, protected/escalator variants, points leader,
game props, any model probability or edge label.

## Data

New table `kalshi_markets`, one row per Kalshi ticker (upsert on `ticker`):

| column | type | notes |
|---|---|---|
| ticker | text PK | |
| series | text | e.g. KXNBAPTS |
| stat | text | points, rebounds, assists, three_pointers, pra, double_double, triple_double |
| player | text | as Kalshi spells it |
| strike | int | N in "N+"; 1 for double_double / triple_double |
| game_date | date | parsed from the ticker (e.g. 26NOV06) |
| away, home | text | team codes as they appear in the ticker; normalized with `normalizeTeamAbbr` at display time |
| yes_bid, yes_ask | numeric | 0..1; null when that side of the book is empty |
| first_yes_ask | numeric | yes_ask when the ticker was first seen; never overwritten |
| volume | int | |
| status | text | Kalshi status (active, closed, finalized, ...) |
| result | text | 'yes' / 'no' once finalized, else null |
| first_seen_at, updated_at | timestamptz | |

Index on `game_date`. RLS on with the standard `"anon_read"` select policy; writes
only via the service role (consistent with migration 20261025140000). Migration file:
`supabase/migrations/20261106120000_kalshi_markets.sql`.

No per-snapshot history table in phase 1: 30-minute snapshots of ~1,000 markets a
day would add about 400 MB a season on the free tier. `first_yes_ask` gives a
movement indicator; the CLV work in the paper ledger already covers closing prices.

## Ingestion

- `scripts/kalshi_edges/market_data.py`: add `KXNBA2D` -> `double_double` and
  `KXNBA3D` -> `triple_double` to the series map used by ingestion, and parse
  titles of the form `"<Player>: Double Double"` / `"<Player>: Triple Double"`
  (verified live 2026-11-06: `KXNBA2D-26NOV06MINNOP-MINTLYLES41`,
  title "Trey Lyles: Double Double", floor_strike 0.5, strike_type greater).
  The scanner's own `PROP_SERIES` stays unchanged so the paper ledger is unaffected.
- New `scripts/kalshi_edges/ingest.py`: `fetch` (reuses `fetch_markets` with its
  429 retry/backoff), `to_rows` (pure mapping KalshiProp/market dict -> table row),
  `upsert` (service-role Supabase upsert in pages of 500; a BEFORE UPDATE trigger
  keeps `first_yes_ask` / `first_seen_at` from the first insert), and
  `settle(date)` (fetch that date's settled markets and PATCH `status` / `result`
  onto existing rows, leaving the last traded prices intact).
- Thin entry scripts `scripts/kalshi_ingest.py` and `scripts/kalshi_settle.py`
  (pipeline `python` steps take no arguments; settle uses yesterday ET).
- Pipeline (`scripts/pipeline/phases.py`):
  - midday and every pretip run: step `kalshi_ingest` (not critical).
  - overnight: step `kalshi_settle` for the previous game date (not critical).
  - Both log to `job_runs` like every other step, so `/status` shows them.
- Kalshi market reads need no auth; the step runs on GitHub Actions. If a cloud
  IP is ever blocked, the fallback is a PC task like the defense refresh.

## App

### Routing and mode switch

- Sportsbook mode stays on its current routes, unchanged.
- Markets mode lives under `/markets` with its own `app/markets/layout.tsx` and nav:
  Home `/markets`, Feed `/markets/feed`, Edge `/markets/edge`, Trends
  `/markets/trends`, Props `/markets/props`, Performance `/markets/performance`.
- A segmented "Sportsbook | Prediction Markets" toggle at the top of the nav. It
  maps the current tab to its counterpart (`/props` <-> `/markets/props`, `/` <->
  `/markets`); routes with no counterpart (player, game, status) go to the other
  mode's home.
- In phase 1 every markets tab except Props renders a short placeholder card
  naming the phase that builds it.

### Props tab (`/markets/props`)

- Data: today's `kalshi_markets` rows (ET game date) for the seven in-scope
  stats, plus `player_game_logs` for the matched players (paged at 1000 rows).
- Layout: games -> players -> one ladder per stat, rungs sorted ascending.
- Each rung shows: strike ("25+"), yes bid / ask in cents, break-even probability
  = ask + Kalshi taker fee (0.07 x p x (1-p)), arrow vs `first_yes_ask`, and hit
  rate at that rung over the last 5, the last 10, and the current season (e.g.
  "6/10"), using `seasonDateRange(CURRENT_SEASON)`.
- DD/TD hit rate: a game counts as a double-double when at least two of points,
  rebounds, assists, steals, blocks are >= 10 (three for a triple-double).
- Rungs with spread > 10 cents or an empty side are shown dimmed.
- Players are matched to game logs with `playerNameVariants`; no match shows
  "no history" instead of hit rates.
- Filters: stat, game. Header shows "Prices as of HH:MM ET" from the newest
  `updated_at`, with a stale warning if older than 90 minutes.
- No edge, tier, or recommendation labels.

### Code layout

- `lib/kalshi/ladder.ts` (pure): `groupLadders(rows)`, `hitRate(logs, stat, strike)`,
  `isDoubleDouble(log)`, `isTripleDouble(log)`, `breakEven(ask)`, `kalshiFee(p)`.
- `app/markets/layout.tsx`, `app/markets/props/page.tsx`, placeholder pages for
  the other five tabs, toggle in `components/NavTabs.tsx` (or a small
  `ModeToggle` component it renders).

## Error handling

- Ingest failure: step fails in `job_runs` (GitHub failure email as usual); the
  page keeps the last stored prices with their timestamp.
- Missing team codes or unparseable titles: row skipped and counted in the step's
  output, never written half-filled.
- No markets today: page shows "No Kalshi player props listed for today yet."

## Testing

- Vitest (`lib/kalshi/ladder.test.ts`): ladder grouping and sort, hit rates over
  L5/L10/season windows, DD/TD detection including the steals/blocks cases,
  break-even and fee.
- Pytest (`scripts/tests/`): DD/TD title parsing, `to_row` mapping, collect skip counting,
  settle grouping of finalized results (first_yes_ask kept by the DB trigger).
- CI runs both as today. After deploy, a live check of `/markets/props` on a game
  day with the preview browser, plus the `kalshi_ingest` row on `/status`.

## Success criteria

- On a game day, `/markets/props` lists every in-scope Kalshi rung for that day's
  games with prices no older than one pretip cycle.
- Hit rates for a spot-checked player match a manual count from game logs.
- `kalshi_settle` fills `result` for the previous day's finalized markets.
- Sportsbook mode pages are unchanged.
