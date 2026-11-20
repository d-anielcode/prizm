# 3PM Zone Simulation Engine

**Date:** 2026-04-07
**Status:** Approved

## Overview

Add a Monte Carlo simulation engine for 3PM (three-pointers made) player props that uses NBA shot chart zone data and opponent zone-specific defense to produce probability estimates. Runs as a Python script in the existing GitHub Action, writes results to Supabase, and feeds into the confidence model as an additive adjustment.

## Architecture

```
nba_api (shot charts)          Supabase (today's 3PM props)
        \                              /
         Python sim script (GitHub Action)
                    |
           sim_3pm table (Supabase)
                    |
     /api/enrich reads sim_3pm
                    |
     additive adjustment to 3PM confidence score
```

## Components

### 1. Supabase Table: `sim_3pm`

Already created by user. Schema:

```sql
create table sim_3pm (
  id            bigint generated always as identity primary key,
  player_name   text not null,
  opponent      text not null,
  game_date     date not null,
  line          numeric not null,
  p_over        numeric not null,
  p_under       numeric not null,
  sim_mean      numeric not null,
  sim_std       numeric not null,
  edge_over     numeric,
  n_sims        int not null default 10000,
  created_at    timestamptz default now(),
  unique(player_name, opponent, game_date, line)
);
```

### 2. Python Script: `scripts/sim_3pm.py`

**Dependencies:** `nba_api`, `numpy`, `requests`

**Pipeline:**

1. Query Supabase `props` table for today's `three_pointers` props. Extract unique (player_name, opponent, line) tuples.

2. For each player, fetch current-season 3PA shot chart from `nba_api.stats.endpoints.shotchartdetail`. Uses pre-labeled `SHOT_ZONE_BASIC` field ("Left Corner 3", "Right Corner 3", "Above the Break 3") — no GMM clustering needed.

3. Compute player zone FG%: `made / attempted` per `SHOT_ZONE_BASIC` zone.

4. Fetch league-wide 3PA shot chart (player_id=0, team_id=0). Group by defensive team + zone to get opponent zone defense FG% allowed. Compute defensive adjustment: `opponent_zone_fg% / league_avg_zone_fg%`.

5. Bootstrap FGA/game: from player's per-game 3PA counts, bootstrap to estimate mean and std. Adjust mean by opponent factor: `opponent_total_3PA_allowed / league_avg_3PA_allowed`.

6. Monte Carlo simulate 10,000 games:
   - FGA ~ Poisson(adjusted_mean)
   - Each attempt assigned to zone by player's zone attempt distribution
   - Make probability = zone FG% x opponent defense adjustment
   - Bernoulli draw per attempt
   - Sum makes = simulated 3PM for that game

7. Compute `p_over = count(sim > line) / n_sims`, `p_under = count(sim < line) / n_sims`, mean, std.

8. Upsert to `sim_3pm` via Supabase REST API (same pattern as existing `fetch_defense_dvp.py`).

**Conventions:** Follows existing Python script patterns:
- Reads `.env.local` for local dev, falls back to env vars for CI
- Uses raw `requests` for Supabase REST API (no SDK)
- `--dry-run` flag for testing

**Rate limiting:** 1-second delay between nba_api calls to avoid throttling.

**Runtime:** ~15-20 seconds per player, ~5 minutes total for ~15 players.

### 3. GitHub Action: `daily-stats.yml`

New step added **after** "Refresh today's props" and **before** "Enrich props" in both schedule runs:

```yaml
- name: Run 3PM zone simulations
  continue-on-error: true
  run: |
    pip install nba_api numpy requests -q
    python3 scripts/sim_3pm.py
  env:
    NEXT_PUBLIC_SUPABASE_URL: ${{ secrets.NEXT_PUBLIC_SUPABASE_URL }}
    SUPABASE_SERVICE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}
```

Runs on both the 5 AM full pipeline and 11 AM midday refresh (opponent matchups don't change, but lines shift — sim re-runs with updated lines).

### 4. Confidence Model: `lib/confidence.ts`

**Integration point:** New additive adjustment `simAdj` applied only to `three_pointers` props.

**Data fetch:** `/api/enrich` loads today's `sim_3pm` rows in the parallel data fetch block (alongside defense stats, DVP, etc.). Builds a lookup map keyed by `player_name + opponent`.

**Adjustment logic:**

```
simEdge = p_over - 0.50

simEdge > 0.10  → +6 pts
simEdge > 0.05  → +4 pts
simEdge > 0.02  → +2 pts
simEdge < -0.02 → -2 pts
simEdge < -0.05 → -4 pts
simEdge < -0.10 → -6 pts
```

Capped at +/-6 — same magnitude as existing `lineMovAdj` and `biasAdj`.

**Confidence reason:** Appends "3PM sim: {p_over}% over (zone-adjusted)" when sim data is present.

### 5. Fallback Behavior

- Missing sim row for a player: no adjustment, scores normally. Zero coupling.
- Entire sim step fails: `continue-on-error: true` means enrich still runs.
- Stale data: enrich only reads `sim_3pm` rows where `game_date = today`.

## Files Changed

| File | Change |
|------|--------|
| `scripts/sim_3pm.py` | **New** — simulation script |
| `.github/workflows/daily-stats.yml` | Add sim step before enrich |
| `lib/confidence.ts` | Add `simAdj` for 3PM props |
| `app/api/enrich/route.ts` | Fetch `sim_3pm` data, pass to scorer |

## Testing

- Run `scripts/sim_3pm.py --dry-run` locally to verify sim output without writing to Supabase.
- Verify sim results appear in `sim_3pm` table after manual GitHub Action trigger.
- Verify `/api/enrich` logs show sim adjustment being applied to 3PM props.
- Compare 3PM LOCK/PLAY distribution before and after to confirm adjustments are reasonable.
