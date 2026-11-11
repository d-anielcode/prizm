# Prizm

A full-stack NBA player-prop analytics engine. Prizm pulls live prop lines from sportsbooks every day, scores each one with an empirically-calibrated confidence model, grades its own past predictions against real box scores, and surfaces the highest-conviction picks and parlays through a Next.js dashboard.

Live: [prizmproject.vercel.app](https://prizmproject.vercel.app)

## What it does

Every game day, on an automated schedule:

1. **Ingests** the day's player props (points, rebounds, assists, threes, PRA, steals, blocks) from The Odds API, and generates synthetic alternate lines around each book line to widen the search space.
2. **Enriches** every prop with a confidence score from a weighted model that blends 11 factors — matchup defense, home/away splits, recent-form trend, line value vs. the player's own distribution, pace, rest, blowout risk, injury news, and head-to-head history — plus empirical adjustments (per-player over/under bias, opponent stat leaks, minutes-uncertainty penalties).
3. **Labels** each prop `LOCK` / `PLAY` / `LEAN` against stat-specific thresholds tuned on historical hit rates.
4. **Builds parlays** — correlated, cross-game tickets (VALUE / PREMIUM / JACKPOT) with strict per-team and per-game caps.
5. **Grades itself** — after games finish, every scored prop is checked against ESPN box scores (hit / miss / DNP), and daily hit rates are tracked by confidence label so the model's real-world accuracy is measurable.

The result is a self-correcting loop: predictions are logged, graded, and fed back into per-player bias and opponent-leak tables that sharpen the next day's scores.

## The confidence model

The engine (`lib/confidence.ts`) is a transparent, deterministic weighted model — not a black box. Each stat type gets its own weight set, and scores are built from:

- **Matchup edge** — opponent defensive rank for the specific stat
- **Home/away & recent-form** — the strongest signals once full-season data is present
- **Line value** — z-score of tonight's line vs. the player's rolling distribution
- **Pace, rest, blowout risk, injury news, head-to-head** — contextual modifiers
- **Empirical corrections** — over-bias adjustment (overs historically hit ~43% vs. unders ~50%), minutes-uncertainty penalties for bench players, and line/odds-movement tracking vs. the morning snapshot

Thresholds and weights are backtested against a library of historical prop lines and graded outcomes, not hand-waved.

## Architecture

```
The Odds API ──> /api/props ──> Supabase (props + synthetic alts + snapshot)
                                      │
ESPN box scores ──> /api/gamelogs ────┤
                                      ▼
                              /api/enrich  ──>  confidence model v6  ──> scored props
                                      │
                              /api/feed (parlays)        /api/grade ──> hit/miss/DNP
                                      │                        │
                                      ▼                        ▼
                          Next.js dashboard          /api/results (daily hit rates)
                                                     /api/player-bias, /api/opponent-leaks
```

**Stack:** Next.js 16 (App Router) · React 19 · TypeScript · Supabase (PostgreSQL) · Tailwind + shadcn/ui · Recharts · Vercel (20 scheduled cron jobs) · Python (offline backtesting & weight optimization)

**Key directories:**
- `app/` — dashboard pages: props board, feed (parlays), edge finder, performance, trends
- `app/api/` — the ingest → enrich → grade pipeline, each route triggered by a Vercel cron
- `lib/confidence.ts` — the confidence engine
- `lib/odds-api.ts` / `lib/espn-gamelogs.ts` — live data adapters
- `scripts/` — Python backtesting, calibration, weight optimization, and the Kalshi edge finder
- `scripts/kalshi_edges/` — bridges Prizm's model probabilities to Kalshi NBA markets to find priced edges

## How it's graded

Prizm keeps an honest scoreboard. Every prediction is snapshotted before tip-off and graded after the final whistle:

- `prop_grades` — individual results (hit / miss / DNP)
- `prop_results` — aggregated daily hit rates by confidence label
- `player_line_bias` / `opponent_stat_leaks` — systematic biases mined from the full game-log history and reapplied as score adjustments

This makes the model falsifiable — you can see whether a `LOCK` actually locks.

## Running locally

```bash
npm install
cp .env.example .env.local   # add Supabase + The Odds API keys
npm run dev                  # http://localhost:3000
npm test                     # vitest
```

The scheduled pipeline runs on Vercel cron (see `vercel.json`); locally you can hit the `/api/*` routes directly to seed, enrich, and grade.

## License

MIT
