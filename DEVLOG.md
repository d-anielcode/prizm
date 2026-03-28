# Prizm — Development Log

NBA prop betting confidence app. Built on Next.js 15 / Supabase / Vercel.

---

## 2026-03-28 — Auth Header Fixes, Streak Bar UX

### Fire-and-Forget Auth Fix
- Fixed internal streak fire-and-forget missing `CRON_SECRET` bearer header — calls to `/api/feed/generate/streak` were returning 401 silently after the auth hardening on Mar 27
- Enrich now immediately re-triggers after props refresh (removed previous fire-and-forget removal) using `internalAuthHeaders()`

### Streak Bar Visual Fix
- **Feed page**: rebuilt 10-bar streak tracker — today's pending picks now appear as the first (leftmost) 2 bars, pulsing solid orange
- **On miss**: bars reset to empty — no red bars carried forward. Only the active current streak (green pairs) + today's pending are shown
- **Root cause**: old logic filled bars oldest→newest (today was rightmost), and showed miss history as red bars. `bg-orange-400/50` also rendered brownish — fixed to `bg-orange-400`
- Same fix applied to performance/streaks tab bubble tracker

---

## 2026-03-27 — Streaks Feature, Security Hardening, Performance Page Overhaul

### Daily Streak Challenge
- **New feature**: `/api/feed/generate/streak` — selects top 2 LOCK props by confidence each day, stored as `curated_parlays` with `parlay_type='streak'`
- Exclusions: steals/blocks excluded (integer stats, too volatile for daily challenge); at least 1 OVER enforced (UNDER bias from -3pt correction skews model)
- Feed page: 10-bubble streak progress bar with pulsing orange pending state
- `feed/grade` updated to grade streak entries alongside parlays

### Streak Quality Fixes (same day)
- Fixed `l10_hits` calculation for UNDER legs in parlay generator — was always using OVER logic (`> line`), showing wrong hit rates
- Fixed wrong opponent display in reasoning text: `prop.team='TBD'` (The Odds API doesn't return player team) caused opponent name to always resolve to the away team; now derives correct opponent from game log `opponentAbbr`
- Suppressed `TBD` team label in feed cards

### Performance Page — 3-Tab Layout
- Restructured `/performance` into **Prop History / Parlays / Streaks** tabs via URL searchParams — only loads data for the active tab
- **Streaks tab**: stat cards (current streak, longest streak, hit rate, days tracked), 10-bubble tracker, current streak picks with actuals, full history accordion
- **Model Calibration section**: paginated read of all graded props → OVER vs UNDER hit rates, per-label breakdown, score calibration table (buckets 50–54 through 85+, expected vs actual, green/yellow/red delta)
- **OVER correction advisor**: compares current -3pt adjustment to what data recommends; highlights in amber if recalibration needed

### Player Page Enhancements
- **Pick History**: queries `prop_grades` for past Prizm picks for each player — shows date, stat, line, label, actual value, hit/miss
- **Line Movement**: `LineMovement` and `SharpMoneyBadge` components — ↑/↓ arrow next to line number; STEAM badge when sharp money confirms pick direction, COUNTER when it opposes

### Player-Bias & Opponent-Leaks Bootstrap
- Bootstrapped `player_line_bias`: 38,049 props analyzed → 1,218 player/stat entries. Top over-hitters: Dejounte Murray PTS, Trae Young PTS/PRA, Dillon Brooks PTS/PRA
- Bootstrapped `opponent_stat_leaks`: 186 team/stat entries. Notable: Chicago STL (72.2%), Orlando BLK (81.8%), Sacramento AST/PRA/REB
- Both factors now active in confidence model with ±5pt and ±4pt adjustments respectively

### Security Hardening
- `lib/api-auth.ts`: `CRON_SECRET` bearer-token auth with constant-time comparison; `requireCronAuth()` + `internalAuthHeaders()` helpers
- `lib/logger.ts`: structured JSON logging (newline-delimited) for Vercel log drains
- `middleware.ts`: edge middleware logs all `/api/` requests (method, path, IP, isCron, reqId); warns on non-cron write attempts
- `next.config.ts`: security headers on all responses — X-Frame-Options DENY, X-Content-Type-Options nosniff, HSTS 1yr, Referrer-Policy, Permissions-Policy, CSP
- All 13 mutation routes now gated behind `requireCronAuth()`; feed GET and results GET remain public

### Player Aliases
- Fixed Nolan Traoré accent, Alex→Alexandre Sarr
- Confirmed Tim Hardaway Jr. and Wendell Carter Jr. need no transform

### Cron Schedule Updates
- Moved `feed/grade` to 14:05 UTC (after late game logs at 13:55)
- Added parlay regen at 14:50 and 19:30 UTC
- Removed redundant 12:30 parlay regen

---

## 2026-03-25 (continued) — Alt Lines, Critical Pagination Fix, Game Log Pipeline

### Alt Lines Overhaul (`PropsTable`)
- Section tabs on props page: All / LOCK / PLAY / LEAN / FADE filter
- Alt lines now generated synthetically when real lines are unavailable
- `lineEasinessAdj`: +2pt per step away from main line in the favorable direction
- **Fix**: alt line scoring was using the weak no-season-stats path (`f2*0.70 + f11*0.30`) — missing `seasonStats/playerBias/opponentLeak` context meant alt lines scored ~11pts below main line. Passed full context through enrich route
- **Fix**: players with <3 game logs (injury returns, new acquisitions) now capped at 65 (PLAY) — season avg alone was pushing e.g. Watson REB 3.5 to 78 LOCK

### Critical Game Log Pagination Bug
- `loadPagedGameLogs` and `loadPagedHistLines` used `PAGE=2000` but Supabase PostgREST caps at 1000 rows
- Loop broke after first page (1000 < 2000 → thought it was the last page), loading only ~6 games/player instead of 50+
- **Fix**: `PAGE=1000` — loop now correctly continues when Supabase returns a full page
- Impact: confidence model was severely degraded for all scoring since Mar 20 backfill

### Game Log Pipeline Fixes
- `?days=N` mode on `/api/gamelogs` (max 7) — fetches last N days in one call for self-healing missed cron nights; 4 AM cron now uses `?days=3`
- `/api/gamelogs/audit`: new endpoint — cross-references active prop players against `player_game_logs`, returns anyone missing logs
- `/api/gamelogs/migrate`: one-time rename of old ESPN ASCII names to correct Odds-API names; fixed 1,726 rows, audit down from 95 → 12 missing (all injured/inactive)
- Unicode alias fixes: Dončić, Sengün, Jokić, Bogdanović, Porziņģis, Šarić, Čančar
- Added 200ms delay between ESPN box score requests to prevent rate limiting on high-game-count nights (was causing only 4/220 players fetched on 10-game nights)
- Switched gamelogs write path to service client (anon client lacked UPDATE permission)

### Cron Schedule Cleanup
- Removed fire-and-forget enrich from `/api/props` — raced the cron enrich 15 min later, causing `prop_history` deadlocks; ESPN=0 at fire time anyway
- Dropped midday `seasonstats` (14:05) and `results` (14:10) — don't need twice-daily
- Added weekly Sunday crons: `/api/player-bias?action=analyze` at 5:00 AM UTC, `/api/opponent-leaks?action=analyze` at 5:30 AM UTC

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

---

## 2026-03-25 — Model Post-Mortem, v6.2 Engine, Dead Code Cleanup, Parlay Fixes

### Codebase Audit & Dead Code Removal
- Full audit of all 27 API routes, 7 pages, 12 components, 11 lib files
- Deleted `lib/nba-api.ts` — never imported anywhere (634 lines dead code)
- Deleted `components/ParlayBuilder.tsx` — never imported anywhere
- Deleted `app/api/feed/generate/route.ts` — old SGP generator, replaced by parlay route
- Disabled Claude Code "Daily sgp generate" scheduled task (was calling deleted route)
- Confirmed `lib/odds-api.ts` (live props) and `lib/the-odds-api.ts` (historical backfill) are both needed for different purposes
- All 9 cron-called routes confirmed to have GET handlers (Vercel crons use GET)

### Model Post-Mortem: Mar 22–24
Analyzed 835 graded props across 3 days against actual box scores. Key findings:

| Date | LOCK | PLAY | LEAN | FADE |
|------|------|------|------|------|
| Mar 22 | 2/8 (25%) | 17/34 (50%) | 67/133 (50%) | — |
| Mar 23 | 2/3 (67%) | 18/41 (44%) | 81/177 (46%) | — |
| Mar 24 | 0/4 (0%) | 9/18 (50%) | 35/82 (43%) | — |

**Root causes identified:**
- OVER props hit only **43.4%** vs UNDER at **50.1%** — systematic over-pricing of overs by books
- PRA hit only **40.5%** — combined 3-stat prop has too much variance
- LOCKs were scoring 68–73 (barely above PLAY range) — threshold too low for quality
- Bench/role players (< 20 min avg) hit at **65.7%** — but when they get surprise low minutes, their props collapse (Ochai Agbaji 9 min destroyed 2 LOCKs)
- Same-game concentration: Mar 24 had 4 LOCKs from CHAvsSAC; all failed when that game went sideways
- 4 separate half-point near-misses across the 3 days (off by exactly 0.5)

### Confidence Engine v6.2
Three data-driven fixes applied to `lib/confidence.ts`:

1. **Minutes uncertainty penalty** (new additive adjustment)
   - `avg_mins L10 < 20`: −8pts (deep bench / Ochai Agbaji situation)
   - `avg_mins L10 < 24`: −4pts (fringe starter)
   - `stdev > 6 min`: additional −3pts (high rotation variance)
   - Prevents bench players from reaching LOCK/PLAY without overwhelming signal elsewhere

2. **Over bias correction** (new additive adjustment)
   - −3pts applied to ALL OVER props
   - Corrects for books systematically pricing popular OVERs above fair value
   - Empirically: OVERs hit 43.4% vs UNDERs 50.1% (sample: 835 props, 3 days)

3. **PRA threshold increase**
   - LOCK: 74 → 78 (base 68 + 10pp offset, up from +6pp)
   - PLAY: 66 → 68
   - PRA empirically hit at 40.5%, lowest of any stat type

### Auto-Enrich After Props Refresh
- `/api/props` now fires `fetch(/api/enrich?force=true)` as fire-and-forget after every fresh prop fetch
- Fixes blank LOCK/PLAY/LEAN/FADE counts seen after manual or cron prop refreshes
- Applies to all triggers: morning cron, midday refresh, manual `?refresh=true`

### Parlay Generator Fixes (`/api/feed/generate/parlay`)

**Quality filters — minimum line thresholds:**
- Points: line ≥ 10.5 (removes trivial 5pt lines)
- Rebounds: line ≥ 3.5
- Three pointers: line ≥ 1.5 (removes "OVER 0.5 threes" coinflips)

**Strict team correlation — removed same-team fallback:**
- Previously: tried strict (1 player/team), fell back to relaxed if pool was thin
- Now: strict-only. If full parlay can't be built with all-different teams, return null
- Better to skip a tier than publish a same-team correlation parlay

**Race condition fix — duplicate parlays:**
- Root cause: 3 concurrent cron calls all read `existingValue=0` before any wrote → 3 identical VALUE parlays inserted (same timestamp, same legs)
- Fix: use parlay `title` as natural unique key. After generating, fetch existing titles for the date and only insert parlays whose title isn't already saved. Concurrent duplicates harmlessly skip.
- Deleted the 3 duplicate Mar 25 VALUE parlays from DB

### Updated Vercel Cron Schedule (corrected)
| Time (UTC) | Route | Purpose |
|-----------|-------|---------|
| 04:10 | `/api/gamelogs` | Fetch ESPN box scores |
| 04:15 | `/api/feed/grade` | Grade completed parlays |
| 04:20 | `/api/seasonstats` | Update season averages |
| 04:25 | `/api/results?force=true` | Aggregate prop results |
| 04:35 | `/api/props?refresh=true` | Fetch next day's props |
| 04:40 | `/api/grade` | Grade individual prop model performance |
| 04:50 | `/api/enrich?force=true` | Score props (also auto-triggered by props refresh) |
| 05:05 | `/api/feed/generate/parlay` | Generate VALUE/PREMIUM/JACKPOT parlays |
| 12:00 | `/api/props?refresh=true` | Midday line refresh |
| 12:15 | `/api/enrich?force=true` | Re-score with updated lines |
| 12:30 | `/api/feed/generate/parlay` | Regenerate parlays with fresh scores |
| 13:55 | `/api/gamelogs` | Afternoon game log update |
| 14:05 | `/api/seasonstats` | Afternoon season stats update |
| 14:10 | `/api/results?force=true` | Afternoon results update |
| 14:20 | `/api/props?refresh=true` | Afternoon line refresh |
| 14:35 | `/api/enrich?force=true` | Afternoon re-score |
| 23:00 | `/api/props/snapshot` | Pre-game odds snapshot (morning baseline) |
