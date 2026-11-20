# Kalshi NBA Prop Edge Finder — Design

**Date:** 2026-06-08
**Status:** Approved (design phase)
**Scope:** v1 = read-only edge finder. No auth, no orders, no paper-trade logging.

## Purpose

Surface mispriced NBA player-prop contracts on Kalshi by comparing Prizm's model
probability against the Kalshi market's ask price. Kalshi prices are clean implied
probabilities (Yes cents ≈ probability) with a two-sided order book and no baked-in
sportsbook vig, which makes EV computation against Prizm's model direct:

```
edge = P_model(stat >= strike) - yes_ask
```

The tool reuses Prizm's existing confidence model and Supabase data. It is a *filter
on top of Prizm*, not a new data source: Kalshi lists ~12 prop markets on a typical
NBA night, while Prizm scores thousands.

## The core problem

Kalshi uses **milestone strikes** (e.g. "30+ points"). Prizm's confidence score is
calibrated to the **sportsbook line** the prop was scored against, not to an arbitrary
strike. So we cannot read an edge straight off the confidence score; we need
`P(stat >= K)` evaluated at Kalshi's K.

## The probability bridge (decided approach: full confidence-score coupling)

We do **not** translate individual factors into stat units. Instead we use the one
place the score already has a probabilistic meaning: Prizm's calibration table maps a
confidence score to `P(over)` at the sportsbook line. Per player+stat we therefore have
one anchored fact:

```
P(X > book_line) = apply_calibration(stat, score)
```

Bridge steps:

1. **Baseline** — fit a distribution to the player's recent game logs: mean `mu0`,
   dispersion, per stat family.
2. **Anchor** — solve for a single mean-shift `delta` such that, under that
   distribution, `P(X > book_line | mu0 + delta) = P_over_anchor`. One 1-D root-find.
   This `delta` absorbs all 12 factors at once — fully coupled, but expressed as one
   well-defined quantity instead of a fuzzy per-factor sum.

   **Direction handling:** `apply_calibration(stat, score)` returns `P(prop hits)`,
   which equals `P(X > line)` only for an *over*-direction prop. So:
   `P_over_anchor = p_hit` if the matched Prizm prop is direction `over`, else
   `1 - p_hit` for direction `under`. (Calibration is fit on the `hit` outcome, and
   `hit` for an under prop means `X < line`.) Always anchor on the over-probability so
   the milestone strike `P(X >= K)` is computed in a single consistent direction.
3. **Extrapolate** — evaluate `P(X >= Kalshi_strike | mu0 + delta)` using the
   distribution's shape.
4. **Edge** — `P(X >= strike) - yes_ask`.

When a Kalshi market has **no matching Prizm prop** (player not scored, or different
player), `delta = 0` → pure log-based distribution, flagged `unfactored`.

### Distribution families

- **Counting stats** (rebounds, assists, three_pointers, steals, blocks): Negative
  Binomial (overdispersed; variance > mean). Dispersion estimated from logs. Fall back
  to Poisson if the NB fit is degenerate.
- **Points, PRA**: Normal with continuity correction.

Continuity: milestone "30+" means `P(X >= 30)`. For the discrete NB this is evaluated
directly; for the Normal we apply a continuity correction (`P(X >= K) ≈ 1 - Phi((K-0.5-mu)/sigma)`).

## Architecture

New self-contained package `scripts/kalshi_edges/`, four focused modules, each
independently testable.

### 1. `market_data.py` — Kalshi reader (no auth)

Public REST `GET /trade-api/v2/markets` + `/events`, filtered to the NBA prop series.
Parses each market into:

```
{ ticker, player, stat, strike, side, yes_bid, yes_ask, volume, close_ts }
```

`strike` and `stat` are parsed from Kalshi's title/subtitle (e.g. "LeBron James 30+
points"). Pure HTTP + parsing; no Supabase, no model. Kalshi prices are fixed-point
dollar strings ("0.6500") — parse to float cents.

### 2. `prizm_data.py` — Supabase reader

Pulls today's scored props (`player_name, stat_type, direction, line,
confidence_score`) from the `props` table and the player game logs. Loads
`lib/calibration-table.json` and exposes `apply_calibration(stat, score) -> p_over`.
One job: hand clean data to the engine. Reads `NEXT_PUBLIC_SUPABASE_URL` +
`SUPABASE_SERVICE_KEY` from environment (sourced from `.env.local`), same pattern as
existing scripts.

### 3. `prob_model.py` — probability engine (the bridge math)

Pure functions, no I/O. Most heavily unit-tested module.

- `fit_distribution(logs, stat) -> Distribution`  (family, mu0, dispersion)
- `solve_shift(dist, book_line, target_p) -> delta`
- `prob_at_strike(dist, delta, strike) -> p`

### 4. `find_edges.py` — orchestrator / CLI

Joins Kalshi markets to Prizm props (normalized name + exact stat match), runs the
engine, computes `edge = p - ask`, ranks, prints a table, and writes
`kalshi_edges_YYYY-MM-DD.json`.

CLI flags: `--min-edge`, `--min-volume`, `--stat`.

### Data flow

```
Kalshi REST ─┐
             ├─► find_edges ─► prob_model ─► ranked edge table + JSON
Supabase ────┘   (join)        (bridge math)
(props + logs + calibration-table.json)
```

### The join (fragile seam)

Kalshi player names vs Prizm `player_name`. Normalize: strip accents, strip suffixes
(Jr./Sr./III), collapse casing/punctuation. Require exact stat match. Unmatched Kalshi
markets still get an `unfactored` edge from pure logs rather than being dropped.

## Error handling (degrade, don't crash — every prop is independent)

- **Kalshi unreachable / market unparseable** → skip that market, log reason.
- **No Prizm match** → `unfactored` edge from pure log distribution (`delta = 0`),
  shown in a separate section.
- **Thin game-log sample** (< 10 games) → skip with reason.
- **`solve_shift` doesn't converge** (score implies a probability the distribution
  can't reach) → clamp `delta` to search bounds, flag `clamped`, keep going.
- **Stale Prizm data** (no props scored today) → loud warning; everything falls back
  to `unfactored`.
- **Name-normalization ambiguity** (two plausible matches) → mark `ambiguous`, exclude
  from actionable table, list for manual review.

## Testing (TDD — tests first, using the project's Python test infra)

- `prob_model.py`:
  - `prob_at_strike` vs known closed-form values (Normal / NB with fixed params).
  - `solve_shift` round-trip: pick a true `delta`, generate the implied `P(over)`,
    confirm the solver recovers it.
  - Monotonicity invariants: higher strike → lower P; higher score → higher `delta`.
  - Degenerate inputs (zero-variance logs, strike far in the tail) clamp, don't throw.
- `market_data.py`: parse a recorded Kalshi JSON fixture → expected structured rows.
  No live network in tests.
- Join logic: accents/suffixes/casing normalization table
  ("Luka Dončić" ↔ "Luka Doncic", "Jaren Jackson Jr.").
- One end-to-end test: Kalshi fixture + sample logs + stub calibration table →
  expected ranked edges.

## Out of scope for v1 (explicit, to prevent scope creep)

- No RSA-PSS auth, no order placement.
- No paper-trade P&L logging to Supabase.
- No scheduled / CI job (run on demand).
- No correlated-parlay construction.

## Dependencies (assumed available; verify at plan time)

- `props` table persists `confidence_score, player_name, stat_type, direction, line,
  game_date` (confirmed via `app/api/enrich/route.ts`).
- Player game logs in Supabase (confirmed: model_diagnostic loads ~57K log rows).
- `lib/calibration-table.json` produced by the weekly `build_calibration.py` job.
- Kalshi public market-data endpoints require no authentication for reads.
- `scipy` for distribution math + root-finding (new dependency for the scripts venv).
