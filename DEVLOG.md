# Prizm — Development Log

NBA prop betting confidence app. Built on Next.js 15 / Supabase / Vercel.

---

## 2026-03-18 — Project Start

### Initial Setup
- Scaffolded Next.js 15 app with TypeScript strict mode, Tailwind CSS
- Connected Supabase (PostgreSQL) — `props`, `prop_alts` tables
- Integrated The Odds API for real NBA prop lines (3,748 props on first pull)
- Integrated BallDontLie API for player stats and season averages

### Confidence Engine v1
- Built `lib/confidence.ts` — 6-factor weighted scoring engine (0–100)
- Factors: season cushion, last 10 hit rate, consistency (CV), trend (L5 vs prior 5), home/away, vs opponent
- Three tiers: HIGH (≥72) / MEDIUM / LOW

### Core API Routes
- `/api/props` — fetches and caches NBA props
- `/api/stats` — player stats with Supabase caching
- `/api/enrich` — scores all props with confidence_score / label / reason

### Early Fixes (same day)
- Switched to NBA.com unofficial API (BallDontLie had rate limits)
- Switched odds source to odds-api.io for better batching
- Made `/api/enrich` respond to GET (Vercel crons use GET, not POST)
- Added neutral fallback scoring when NBA.com is blocked/slow
- Set up Vercel cron for hourly prop refresh

---

## 2026-03-19 — Confidence v2–v4, Mobile, Full Pipeline

### Confidence Engine v2
- Added `vsOpponent` factor (head-to-head splits)
- Added `homeAway` factor (home court advantage)
- Added Bayesian blending for small sample sizes

### Confidence Engine v3 — Blowout & News/Injury Factors
- **Blowout risk (8%)**: ESPN scoreboard spread — large spreads reduce confidence (starters sit in blowouts)
- **News/Injury (7%)**: ESPN injury API — teammate OUT = usage boost, player questionable = risk penalty
- Backtest weights tuned from 9,226 test cases (55.1% accuracy vs 52.8% baseline):
  - `matchupEdge` 16% → 22% (strongest signal)
  - `last20HitRate` 6% → 14%
  - `last10HitRate` 20% → 14%
  - `homeAway` 9% → 5%
  - `vsOpponent` 12% → 7%

### Confidence Engine v4 — Data-Driven Weights
- Applied LR-optimized weights from full backtest
- Added `restDays` factor (back-to-back fatigue, 3%)
- Calibrated HIGH/MEDIUM/LOW thresholds from actual hit rates
- `HIGH ≥65`: ~54–56% historical hit rate
- `LOW <50`: model anti-predicts — UNDER is the lean

### New Features
- **Mobile-responsive layout** across all pages (card view on mobile, table on desktop)
- **Parlay Builder** on home page — lock picks across regenerate
- **Performance page** — daily hit rate tracking with progress bars
- **Results API** (`/api/results`) — calculates prop outcome hit rates per day

### Pipeline Fixes
- Fixed cron order: grade BEFORE deleting tonight's props (was grading 0 props)
- `prop_history` snapshot added to `/api/props` so grading still works after props are replaced
- `fetch_nba_stats.py` — added `--today` and `--yesterday` flags for late-night/morning runs
- Fixed `BoxScoreTraditionalV2` → V3 deprecation
- Fixed `LeagueDashTeamStats` parameter rename
- Stripped quotes from env vars in Python scripts

---

## 2026-03-20 — Full Season Data, Historical Lines, Confidence v5

### Full Season Backfill
- Backfilled full 2025-26 season game logs (Oct 22 → present, **22,817 rows**)
- Added `/api/gamelogs/backfill` with batched date-range processing
- Extracted ESPN box-score fetch to `lib/espn-gamelogs.ts` (shared by gamelogs + backfill)
- Added `/api/gamelogs` Vercel cron to auto-fetch ESPN box scores nightly (replaces manual Python step)

### The Odds API — Historical Lines Backfill
- Built `lib/the-odds-api.ts` — fetches actual DraftKings, FanDuel, Caesars, Fanatics lines per event
- Built `/api/prophistory/backfill` — paginated backfill with `nextUrl` chaining for full-season runs
- Created `historical_prop_lines` table with unique constraint on `(game_date, player_name, stat_type, direction, sportsbook)`
- Result: **82,412 actual historical lines** stored (Feb 4 – Mar 19, 2026)

### Confidence Engine v5 — Line Value & Pace
- **Line value z-score (20%)**: measures how many stddevs L10 avg is above/below tonight's line — eliminates circular logic where old hit rate retroactively applied tonight's static line
- **Pace factor (7%)**: uses ESPN game O/U total as possession proxy; scaled by stat type (pts 100%, reb 60%, 3PM 50%, stl/blk 20%)
- Raised HIGH threshold 65 → 73 (7 HIGH picks vs 31 previously, much tighter consensus)
- Added consensus bonus/penalty: 4+ primary factors agree → +3pts; 0–1 agree → -10pts

### Confidence Engine v5.1 — Recency Decay & Date Windowing
- **Data freshness multiplier**: gap >7d → compress all factor scores toward 0.50; gap >90d → only 15% of signal retained
- **Date-windowed factors**: `lineValueScore` limited to last 60 days; trend/hit rate limited to 90-day window
- **Exponential recency weighting**: most recent game weight 1.0, each game back ×0.93 (game 10 ≈ 0.48×)

### Actual Historical Hit Rate
- `actualHitRate()` matches each game log to real line posted that night by books (consensus average)
- Falls back to old `hitRate()` for games outside 45-day historical window
- Result: hit rates now reflect actual market performance, not synthetic retroactive application

### Player Page Enhancements
- Added **Home/Away splits** table with color highlighting
- Added **vs. [OPPONENT]** splits section using tonight's opponent
- Season averages + Last 20 Games side-by-side
- Derive team from most recent game log (was hardcoded 'TBD')

### Alt Lines Panel
- Game page prop cards now group by player+stat
- Main line = highest confidence, all others collapsible as alt lines
- Each alt shows line, direction, American odds, implied probability

### Pipeline Bug Fixes
- **Pagination bug**: Supabase default 1,000-row limit was silently truncating 78 players × 66 games = 5,148 rows; now paginates via `range()` loop
- **Direction dedup bug**: OVER/UNDER same line were collapsing in results — added direction to dedup key
- **`game_date` bug**: cron runs after midnight so `new Date()` gave next day's date; now derives `game_date` from each prop's own `commence_time`
- **Performance page pagination**: added 30-day window + paginated game log query

---

## 2026-03-21 — Confidence v5.7, 4-Tier Labels, Synthetic Data

### Confidence Engine v5.7 — 4-Tier Labels
- New label system: **LOCK** (≥70) / **PLAY** (≥62) / **LEAN** (≥50) / **FADE** (<50)
- Stat-specific thresholds: assists/PRA ≥76, three_pointers ≥74 (higher bar for volatile stats)
- Weights tuned via Dirichlet random search optimizer (5,000 iterations, min 60 LOCK props)
- Backtest results (v5.7, combined mode): LOCK 63.5% hit rate, PLAY 57.6% hit rate

### Player & Opponent Adjustments
- **Player line bias** (`player_line_bias` table): ±5pt max adjustment, min 6 samples — captures systematic over/under tendencies per player+stat
- **Opponent stat leaks** (`opponent_stat_leaks` table): ±4pt max adjustment, min 10 samples — e.g. teams that consistently give up above-line rebounds

### New API Routes
- `/api/backtest` — scores all historical/synthetic props, returns hit rates by tier
- `/api/player-bias` — analyzes and upserts `player_line_bias` table
- `/api/opponent-leaks` — analyzes and upserts `opponent_stat_leaks` table
- `/api/coverage` — prop coverage and data freshness stats
- `/api/synthetic/analyze` — ratio distribution for synthetic line generation
- `/api/synthetic/generate` — generates synthetic prop lines from game logs

### Weight Optimizer
- `scripts/optimize-weights.ts` — Dirichlet random search (pre-computes all factors once, 5,000 weight combos)

### HIGH/MEDIUM/LOW → LOCK/PLAY/LEAN/FADE Migration
- Updated all references across: `ResultsHistory`, `ParlayBuilder`, `performance/page.tsx`, `api/results/route.ts`
- `ResultsHistory`: new 4-tier colors (violet/emerald/amber/red), 6-column table

### AI Parlay Builder v3
- New presets: **Safe** (2-leg), **Standard** (3-leg), **Power** (5-leg), **Lottery** (8-leg)
- Game-diverse pick selection: prefers one pick per game for independence
- Per-pick hit probability calibrated from v5.7 backtest (linear fit through LOCK 63.5% / PLAY 57.6%)
- Joint hit estimate = product of individual probabilities, color-coded by range
- Historical hit rate ranges shown in controls panel
- Lock picks survive across regenerate

---

## 2026-03-22 — Parlay Feed, Full Pipeline Debug, Backtest Suite

### Curated Parlay Feed (`/feed`)
Three daily parlay tiers auto-generated from LOCK+PLAY over props:
- **VALUE** (1× 3-leg "Consistent Pick") — no minutes filter, ~33.3% hit rate, ~5× multiplier, 53.7% ROI
- **PREMIUM** (3× 4-leg "High Roller") — 24+ avg min filter, ~15.8% hit rate, ~10× multiplier, 67.6% ROI
- **JACKPOT** (1× 5-leg "Jackpot") — 24+ avg min filter, ~11.5% hit rate, ~17.5× multiplier, 80.9% ROI

Markets: PTS / REB / 3PM (assists removed — only 40% hit rate)
Multipliers: `PARLAY_VIG_FACTOR = 0.85` applied to displayed estimate (sportsbook vig discount)
Default odds: -130 (fallback for synthetic/missing odds)

### New Routes
- `/api/feed` — reads `curated_parlays` table, returns active parlays grouped by date
- `/api/feed/generate/parlay` — generates and saves VALUE/PREMIUM/JACKPOT parlays; idempotent (skips if already generated)
- `/api/feed/grade` — grades completed parlays, writes `result` back to `curated_parlays`
- `/api/grade` — prop-level grading: matches `prop_history` against `player_game_logs`, upserts to `prop_grades`
- `/api/props/snapshot` — nightly odds snapshot before props table is wiped
- `/api/prophistory/enrich` — enriches historical props from `synthetic_prop_lines` / `prop_history`
- `/api/synthetic/calibrate` — calibrates synthetic line generation ratios

### Backtest Suite
- `/api/backtest/multi-parlay` — full structure sweep (parlaysPerDay × legsPerParlay × minMins × markets × tiers) with `?source=real|synthetic|combined` parameter
  - `real` = dates ≥ 2026-02-04 (actual sportsbook lines)
  - `synthetic` = dates ≤ 2026-02-03 (synthetic lines, -130 default odds)
  - Returns `sourceComparison` block with all three sources in one response
- `/api/backtest/parlays` — daily parlay strategy backtester
- `/api/backtest/sgp-feed` — SGP (same-game parlay) feed backtester

### Validated Backtest Results (real data, 35 dates)
| Tier | Config | Hit Rate | ROI |
|------|--------|----------|-----|
| VALUE | 3-leg, no filter | 33.3% | 53.7% |
| PREMIUM | 4-leg, 24+ min | 20.0% | 67.6% |
| JACKPOT | 5-leg, 24+ min | 11.5% | 80.9% |

### Bug Fixes
- **Home page**: `await fetch(enrich)` was blocking page render 30–60s — changed to fire-and-forget
- **Enrich auto-trigger**: parlay generator was called without `?date=` — derived from `commence_time` and passed correctly
- **Performance page**: "All-time N days tracked" showed `sortedDates.length` (max 3) instead of `byDate.size`
- **`feed/grade` GET alias**: Vercel cron uses GET, but route only handled POST — added GET alias

### Supabase Migrations
- `curated_parlays_result.sql` — added `result` column to `curated_parlays`
- `add_value_parlay_type.sql` — added `'value'` and `'jackpot'` to `parlay_type` CHECK constraint (was only `'premium'` and `'sgp'`)

### Vercel Cron Schedule (final)
| Time (UTC) | Route | Purpose |
|-----------|-------|---------|
| 04:10 | `/api/gamelogs` | Fetch ESPN box scores |
| 04:20 | `/api/seasonstats` | Update season averages |
| 04:25 | `/api/results` | Aggregate prop results |
| 04:30 | `/api/feed/grade` | Grade completed parlays |
| 04:35 | `/api/props` | Fetch tomorrow's props |
| 04:50 | `/api/enrich` | Score props + auto-generate parlays |
| 13:55 | `/api/props` | Afternoon line refresh |
| 14:10 | `/api/enrich` | Re-score with updated lines |

### Build Fixes (TypeScript)
- `backtest/multi-parlay`: cast `tiers` to `readonly string[]` before `.includes('LEAN')` — TypeScript inferred literal tuple type `readonly ['LOCK', 'PLAY']` and rejected `'LEAN'` as argument
- `enrich/route.ts`: double-cast `ScoredProp` via `unknown` before `Record<string, unknown>`
- `feed/generate/parlay`: `buildResult()` was missing `tier` in return object
- `lib/confidence.ts`: removed `as const` from weight objects — literal types prevented `W_VOLATILE` and `W_THREE_POINTERS` from using different values
