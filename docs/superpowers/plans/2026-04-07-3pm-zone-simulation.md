# 3PM Zone Simulation Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Monte Carlo simulation engine for 3PM props using NBA shot chart zones and opponent zone defense, running as a Python GitHub Action step that writes to Supabase, consumed by the confidence model as an additive adjustment.

**Architecture:** Python script (`scripts/sim_3pm.py`) fetches today's 3PM props from Supabase, pulls shot chart data from nba_api, simulates 10k games per player using zone-specific shooting percentages adjusted for opponent defense, and upserts results to `sim_3pm`. The existing `/api/enrich` route reads `sim_3pm` and applies a ±6pt additive adjustment to the confidence score for 3PM props.

**Tech Stack:** Python 3 (nba_api, numpy, requests), TypeScript (Next.js), Supabase (PostgreSQL), GitHub Actions

**Spec:** `docs/superpowers/specs/2026-04-07-3pm-zone-simulation-design.md`

---

### Task 1: Python Simulation Script — Data Fetching Layer

**Files:**
- Create: `scripts/sim_3pm.py`

This task builds the script skeleton with credential loading, Supabase query for today's 3PM props, and nba_api shot chart fetching. No simulation logic yet.

- [ ] **Step 1: Create script with credential loading and arg parsing**

```python
"""
3PM Zone Simulation Engine — Monte Carlo simulation using NBA shot chart zones
and opponent zone-specific defense to estimate p(over) for three-pointer props.

Usage:
  python3 scripts/sim_3pm.py
  python3 scripts/sim_3pm.py --dry-run
  python3 scripts/sim_3pm.py --n-sims 50000
"""

import os, sys, argparse, time, json
from datetime import datetime, timezone

import numpy as np
import requests

try:
    from nba_api.stats.endpoints import shotchartdetail
    from nba_api.stats.static import players as nba_players, teams as nba_teams
except ImportError:
    print("ERROR: nba_api not installed. Run: pip install nba_api")
    sys.exit(1)

# ── Credentials (same pattern as fetch_defense_dvp.py) ────────────────────────
env = {}
ENV_PATH = os.path.join(os.path.dirname(__file__), '..', '.env.local')
try:
    with open(ENV_PATH) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
except FileNotFoundError:
    pass

SUPABASE_URL = (os.environ.get('NEXT_PUBLIC_SUPABASE_URL') or env.get('NEXT_PUBLIC_SUPABASE_URL', '')).strip('"').strip("'")
SUPABASE_KEY = (os.environ.get('SUPABASE_SERVICE_KEY') or env.get('SUPABASE_SERVICE_KEY', '')).strip('"').strip("'")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("ERROR: Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_KEY")
    sys.exit(1)

SB_HEADERS = {
    'apikey': SUPABASE_KEY,
    'Authorization': f'Bearer {SUPABASE_KEY}',
    'Content-Type': 'application/json',
    'Prefer': 'resolution=merge-duplicates',
}

CURRENT_SEASON = '2025-26'

# NBA shot zone labels for 3-pointers (from SHOT_ZONE_BASIC field)
THREE_PT_ZONES = ['Left Corner 3', 'Right Corner 3', 'Above the Break 3']

# Build team abbreviation lookups
_TEAM_LIST = nba_teams.get_teams()
TEAM_NAME_TO_ABBR = {t['full_name']: t['abbreviation'] for t in _TEAM_LIST}
TEAM_ABBR_TO_ID = {t['abbreviation']: t['id'] for t in _TEAM_LIST}
TEAM_ID_TO_ABBR = {t['id']: t['abbreviation'] for t in _TEAM_LIST}


def fetch_todays_3pm_props():
    """Query Supabase props table for today's three_pointers props."""
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    url = (
        f'{SUPABASE_URL}/rest/v1/props'
        f'?stat_type=eq.three_pointers'
        f'&select=player_name,team,opponent,home_team,away_team,line,odds,direction,commence_time'
        f'&order=player_name'
        f'&limit=200'
    )
    r = requests.get(url, headers={
        'apikey': SUPABASE_KEY,
        'Authorization': f'Bearer {SUPABASE_KEY}',
    }, timeout=30)
    if not r.ok:
        print(f"ERROR fetching props: {r.status_code} {r.text[:200]}")
        return []
    props = r.json()
    # Deduplicate to unique (player_name, opponent) pairs with their lines
    seen = {}
    for p in props:
        key = p['player_name']
        if key not in seen:
            # Determine opponent abbreviation from home/away teams
            opponent_abbr = None
            player_team = p.get('team', '')
            home = p.get('home_team', '')
            away = p.get('away_team', '')
            if player_team and home and away:
                # Player's team name → abbreviation
                player_abbr = None
                for t in _TEAM_LIST:
                    if t['full_name'] == player_team or t['abbreviation'] == player_team:
                        player_abbr = t['abbreviation']
                        break
                if player_abbr:
                    home_abbr = None
                    away_abbr = None
                    for t in _TEAM_LIST:
                        if t['full_name'] == home or t['abbreviation'] == home:
                            home_abbr = t['abbreviation']
                        if t['full_name'] == away or t['abbreviation'] == away:
                            away_abbr = t['abbreviation']
                    if home_abbr and away_abbr:
                        opponent_abbr = away_abbr if player_abbr == home_abbr else home_abbr

            seen[key] = {
                'player_name': p['player_name'],
                'opponent': opponent_abbr or p.get('opponent', ''),
                'line': float(p.get('line', 2.5)),
            }
    result = list(seen.values())
    print(f"Found {len(result)} unique players with 3PM props today")
    return result


def find_nba_player_id(player_name):
    """Find nba_api player ID by name. Returns (player_id, team_id) or (None, None)."""
    matches = nba_players.find_players_by_full_name(player_name)
    if not matches:
        # Try last name only
        parts = player_name.split()
        if len(parts) >= 2:
            matches = nba_players.find_players_by_last_name(parts[-1])
            matches = [m for m in matches if m.get('is_active')]
    if not matches:
        return None, None
    player_id = matches[0]['id']
    # We don't strictly need team_id for shot charts (can pass 0)
    return player_id, 0


def fetch_player_shot_chart(player_id):
    """Fetch current-season 3PA shot chart for a player. Returns list of dicts."""
    try:
        chart = shotchartdetail.ShotChartDetail(
            player_id=player_id,
            team_id=0,
            season=CURRENT_SEASON,
            season_type_all_star='Regular Season',
            context_measure_simple='FG3A',
            timeout=30,
        )
        df = chart.get_data_frames()[0]
        # Filter to 3-point zones only
        df = df[df['SHOT_ZONE_BASIC'].isin(THREE_PT_ZONES)]
        return df
    except Exception as e:
        print(f"  ERROR fetching shot chart: {e}")
        return None


def fetch_league_shot_chart():
    """Fetch league-wide 3PA shot chart for current season. Returns DataFrame."""
    try:
        chart = shotchartdetail.ShotChartDetail(
            player_id=0,
            team_id=0,
            season=CURRENT_SEASON,
            season_type_all_star='Regular Season',
            context_measure_simple='FG3A',
            timeout=60,
        )
        df = chart.get_data_frames()[0]
        df = df[df['SHOT_ZONE_BASIC'].isin(THREE_PT_ZONES)]
        return df
    except Exception as e:
        print(f"  ERROR fetching league shot chart: {e}")
        return None
```

- [ ] **Step 2: Verify script loads and fetches props**

Run locally:
```bash
cd C:/Users/dcho0/nbaiqproject
python3 scripts/sim_3pm.py --dry-run
```
Expected: Prints "Found N unique players with 3PM props today" (or 0 if no games today).

- [ ] **Step 3: Commit**

```bash
git add scripts/sim_3pm.py
git commit -m "feat: add sim_3pm.py skeleton with data fetching layer"
```

---

### Task 2: Python Simulation Script — Monte Carlo Engine

**Files:**
- Modify: `scripts/sim_3pm.py`

Add the core simulation logic: zone FG% computation, opponent defense adjustment, and Monte Carlo game simulation.

- [ ] **Step 1: Add simulation functions to `scripts/sim_3pm.py`**

Append after the `fetch_league_shot_chart` function:

```python
def compute_zone_stats(player_df):
    """Compute player's FG% and attempt distribution per 3-point zone.
    Returns (zone_fg_pct, zone_attempt_weights, fga_per_game) or (None, None, None) on insufficient data.
    """
    if player_df is None or len(player_df) < 20:
        return None, None, None

    zone_stats = {}
    total_attempts = len(player_df)
    for zone in THREE_PT_ZONES:
        zone_shots = player_df[player_df['SHOT_ZONE_BASIC'] == zone]
        attempts = len(zone_shots)
        if attempts == 0:
            zone_stats[zone] = {'fg_pct': 0.0, 'weight': 0.0}
        else:
            makes = zone_shots['SHOT_MADE_FLAG'].sum()
            zone_stats[zone] = {
                'fg_pct': makes / attempts,
                'weight': attempts / total_attempts,
            }

    # FGA per game: group by GAME_ID, count attempts
    fga_per_game = player_df.groupby('GAME_ID')['SHOT_ATTEMPTED_FLAG'].count().values

    return zone_stats, None, fga_per_game  # zone_attempt_weights derived from zone_stats


def compute_opponent_zone_defense(league_df, opponent_abbr):
    """Compute opponent's zone defense adjustment relative to league average.
    Returns dict of zone → multiplier (>1 means opponent allows more makes in that zone).
    """
    if league_df is None or len(league_df) == 0:
        return {z: 1.0 for z in THREE_PT_ZONES}

    # Need to identify which team was defending each shot
    # ShotChartDetail for player_id=0 includes HTM (shooter's team) and VTM columns
    # We derive defending team: if HTM != VTM, defender is the other team
    # But simpler: use TEAM_NAME to find shooter's team, opponent is the other
    adjustments = {}
    for zone in THREE_PT_ZONES:
        zone_shots = league_df[league_df['SHOT_ZONE_BASIC'] == zone]
        if len(zone_shots) == 0:
            adjustments[zone] = 1.0
            continue

        league_avg_fg_pct = zone_shots['SHOT_MADE_FLAG'].mean()
        if league_avg_fg_pct == 0:
            adjustments[zone] = 1.0
            continue

        # Filter for shots taken AGAINST this opponent (opponent was the defending team)
        # In ShotChartDetail, we need to identify when opponent_abbr was defending
        # The HTM column is home team, VTM is visitor team
        # Shots against opponent = games where opponent was either HTM or VTM, and shooter's team != opponent
        opp_defending = zone_shots[
            ((zone_shots['HTM'] == opponent_abbr) | (zone_shots['VTM'] == opponent_abbr)) &
            (zone_shots['TEAM_NAME'].apply(lambda x: TEAM_NAME_TO_ABBR.get(x, '') != opponent_abbr))
        ]

        if len(opp_defending) < 10:
            adjustments[zone] = 1.0
            continue

        opp_fg_pct = opp_defending['SHOT_MADE_FLAG'].mean()
        adjustments[zone] = opp_fg_pct / league_avg_fg_pct

    return adjustments


def compute_opponent_fga_adjustment(league_df, opponent_abbr):
    """How many 3PA does this opponent allow relative to league average?
    Returns multiplier (>1 means opponent allows more attempts).
    """
    if league_df is None or len(league_df) == 0:
        return 1.0

    # Total 3PA allowed by each defending team
    # Shots against a team = shots where that team is NOT the shooting team
    fga_by_def = {}
    games_by_def = {}
    for _, row in league_df.iterrows():
        htm = row.get('HTM', '')
        vtm = row.get('VTM', '')
        shooter_abbr = TEAM_NAME_TO_ABBR.get(row.get('TEAM_NAME', ''), '')
        if not shooter_abbr or not htm or not vtm:
            continue
        defender = vtm if shooter_abbr == htm else htm
        fga_by_def[defender] = fga_by_def.get(defender, 0) + 1
        games_by_def.setdefault(defender, set()).add(row.get('GAME_ID', ''))

    if not fga_by_def or opponent_abbr not in fga_by_def:
        return 1.0

    # Per-game average
    opp_fga_per_game = fga_by_def[opponent_abbr] / max(len(games_by_def.get(opponent_abbr, {1})), 1)
    all_fga_per_game = [fga_by_def[t] / max(len(games_by_def.get(t, {1})), 1) for t in fga_by_def]
    league_avg = np.mean(all_fga_per_game) if all_fga_per_game else opp_fga_per_game

    return opp_fga_per_game / league_avg if league_avg > 0 else 1.0


def simulate_player(player_name, opponent_abbr, line, zone_stats, fga_per_game,
                     zone_defense_adj, fga_adj, n_sims=10000):
    """Run Monte Carlo simulation for a single player.
    Returns dict with p_over, p_under, sim_mean, sim_std, or None on failure.
    """
    if zone_stats is None or fga_per_game is None or len(fga_per_game) < 3:
        return None

    # Bootstrap FGA mean
    boot_means = [np.random.choice(fga_per_game, size=len(fga_per_game), replace=True).mean()
                  for _ in range(1000)]
    fga_mean = np.mean(boot_means) * fga_adj
    fga_std = np.std(boot_means)

    # Zone weights and adjusted FG%
    zones = [z for z in THREE_PT_ZONES if zone_stats[z]['weight'] > 0]
    if not zones:
        return None
    weights = np.array([zone_stats[z]['weight'] for z in zones])
    weights = weights / weights.sum()  # normalize
    fg_pcts = np.array([zone_stats[z]['fg_pct'] * zone_defense_adj.get(z, 1.0) for z in zones])
    # Clamp FG% to [0.05, 0.65] to avoid degenerate simulations
    fg_pcts = np.clip(fg_pcts, 0.05, 0.65)

    results = np.zeros(n_sims, dtype=np.int32)
    for i in range(n_sims):
        # Draw FGA from Poisson with bootstrapped mean
        fga = np.random.poisson(max(fga_mean, 0.5))
        if fga == 0:
            continue

        # Assign each attempt to a zone
        zone_indices = np.random.choice(len(zones), size=fga, p=weights)

        # Simulate makes
        makes = 0
        for zi in zone_indices:
            if np.random.random() < fg_pcts[zi]:
                makes += 1
        results[i] = makes

    p_over = float(np.sum(results > line) / n_sims)
    p_under = float(np.sum(results < line) / n_sims)
    sim_mean = float(np.mean(results))
    sim_std = float(np.std(results))

    return {
        'player_name': player_name,
        'opponent': opponent_abbr,
        'line': line,
        'p_over': round(p_over, 4),
        'p_under': round(p_under, 4),
        'sim_mean': round(sim_mean, 2),
        'sim_std': round(sim_std, 2),
        'n_sims': n_sims,
    }
```

- [ ] **Step 2: Commit**

```bash
git add scripts/sim_3pm.py
git commit -m "feat: add Monte Carlo simulation engine to sim_3pm.py"
```

---

### Task 3: Python Simulation Script — Main Loop and Supabase Upsert

**Files:**
- Modify: `scripts/sim_3pm.py`

Add the `main()` function that orchestrates the full pipeline: fetch props → fetch shot charts → simulate → upsert.

- [ ] **Step 1: Add upsert and main functions to `scripts/sim_3pm.py`**

Append after the `simulate_player` function:

```python
def upsert_sim_results(results):
    """Upsert simulation results to Supabase sim_3pm table."""
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    rows = []
    for r in results:
        rows.append({
            'player_name': r['player_name'],
            'opponent': r['opponent'],
            'game_date': today,
            'line': r['line'],
            'p_over': r['p_over'],
            'p_under': r['p_under'],
            'sim_mean': r['sim_mean'],
            'sim_std': r['sim_std'],
            'n_sims': r['n_sims'],
        })

    url = f'{SUPABASE_URL}/rest/v1/sim_3pm'
    upserted = 0
    for i in range(0, len(rows), 50):
        chunk = rows[i:i+50]
        r = requests.post(url, headers=SB_HEADERS, json=chunk, timeout=30)
        if r.ok:
            upserted += len(chunk)
        else:
            print(f"  [supabase] error: {r.status_code} {r.text[:200]}")
    return upserted


def main():
    parser = argparse.ArgumentParser(description='3PM Zone Simulation Engine')
    parser.add_argument('--dry-run', action='store_true', help='Print results without writing to Supabase')
    parser.add_argument('--n-sims', type=int, default=10000, help='Number of simulations per player (default: 10000)')
    args = parser.parse_args()

    print(f'\n3PM Zone Simulation Engine')
    print(f'{"="*50}')
    print(f'Season: {CURRENT_SEASON}')
    print(f'Simulations per player: {args.n_sims:,}')

    # 1. Get today's 3PM props
    props = fetch_todays_3pm_props()
    if not props:
        print("No 3PM props found for today. Exiting.")
        return

    # 2. Fetch league-wide shot chart (one call, reused for all players)
    print("\nFetching league-wide 3PA shot chart...")
    league_df = fetch_league_shot_chart()
    if league_df is None:
        print("ERROR: Could not fetch league shot chart. Exiting.")
        return
    print(f"  League shots: {len(league_df)} three-point attempts")
    time.sleep(1)  # rate limit

    # 3. Simulate each player
    results = []
    for i, prop in enumerate(props):
        player_name = prop['player_name']
        opponent_abbr = prop['opponent']
        line = prop['line']

        print(f"\n[{i+1}/{len(props)}] {player_name} vs {opponent_abbr} (line: {line})")

        # Find player in nba_api
        player_id, _ = find_nba_player_id(player_name)
        if player_id is None:
            print(f"  SKIP: Player not found in nba_api")
            continue

        # Fetch player shot chart
        player_df = fetch_player_shot_chart(player_id)
        if player_df is None or len(player_df) < 20:
            print(f"  SKIP: Insufficient shot data ({0 if player_df is None else len(player_df)} attempts)")
            continue
        print(f"  Shot data: {len(player_df)} three-point attempts this season")

        # Compute zone stats
        zone_stats, _, fga_per_game = compute_zone_stats(player_df)
        if zone_stats is None:
            print(f"  SKIP: Could not compute zone stats")
            continue

        # Compute opponent defense adjustment
        zone_defense_adj = compute_opponent_zone_defense(league_df, opponent_abbr)
        fga_adj = compute_opponent_fga_adjustment(league_df, opponent_abbr)
        print(f"  Opponent {opponent_abbr} FGA adjustment: {fga_adj:.2f}x")
        for z in THREE_PT_ZONES:
            adj = zone_defense_adj.get(z, 1.0)
            if zone_stats[z]['weight'] > 0:
                print(f"    {z}: FG% adj {adj:.2f}x (player {zone_stats[z]['fg_pct']:.1%} → {zone_stats[z]['fg_pct'] * adj:.1%})")

        # Run simulation
        sim = simulate_player(player_name, opponent_abbr, line, zone_stats, fga_per_game,
                              zone_defense_adj, fga_adj, n_sims=args.n_sims)
        if sim is None:
            print(f"  SKIP: Simulation failed")
            continue

        print(f"  Result: mean={sim['sim_mean']:.1f}, p(over {line})={sim['p_over']:.1%}, p(under)={sim['p_under']:.1%}")
        results.append(sim)
        time.sleep(1)  # rate limit between players

    print(f"\n{'='*50}")
    print(f"Simulated {len(results)}/{len(props)} players")

    if not results:
        print("No results to save.")
        return

    if args.dry_run:
        print("\n[DRY RUN] Results:")
        for r in results:
            print(f"  {r['player_name']:<25} vs {r['opponent']:<4} line={r['line']}  "
                  f"p(over)={r['p_over']:.1%}  mean={r['sim_mean']:.1f}  std={r['sim_std']:.1f}")
        print("\n[DRY RUN] No upsert made.")
        return

    # 4. Upsert to Supabase
    print(f"\nUpserting {len(results)} rows to sim_3pm...")
    upserted = upsert_sim_results(results)
    print(f"Done. {upserted} sim results saved.")


if __name__ == '__main__':
    main()
```

- [ ] **Step 2: Test locally with dry-run**

```bash
cd C:/Users/dcho0/nbaiqproject
python3 scripts/sim_3pm.py --dry-run --n-sims 1000
```

Expected: Fetches today's 3PM props, runs 1000 sims per player, prints results table. If no games today, prints "No 3PM props found for today."

- [ ] **Step 3: Test with real Supabase upsert (if games today)**

```bash
python3 scripts/sim_3pm.py --n-sims 1000
```

Expected: Prints "N sim results saved." Verify rows appear in `sim_3pm` table in Supabase dashboard.

- [ ] **Step 4: Commit**

```bash
git add scripts/sim_3pm.py
git commit -m "feat: complete sim_3pm.py with main loop and Supabase upsert"
```

---

### Task 4: GitHub Action Integration

**Files:**
- Modify: `.github/workflows/daily-stats.yml`

Add the simulation step to both schedule runs, after props are refreshed but before enrich.

- [ ] **Step 1: Add sim step to `daily-stats.yml`**

Insert a new step **after** the "Refresh today's props from odds API" step (after line 131) and **before** the "Enrich props" step (line 133):

```yaml
      - name: Run 3PM zone simulations
        continue-on-error: true
        run: |
          pip install nba_api numpy requests -q
          python3 scripts/sim_3pm.py || py -3 scripts/sim_3pm.py
        env:
          NEXT_PUBLIC_SUPABASE_URL: ${{ secrets.NEXT_PUBLIC_SUPABASE_URL }}
          SUPABASE_SERVICE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}
```

The full modified section (lines ~119–145 area) should read:

```yaml
      - name: Refresh today's props from odds API
        continue-on-error: true
        env:
          VERCEL_APP_URL: ${{ secrets.VERCEL_APP_URL }}
          CRON_SECRET: ${{ secrets.CRON_SECRET }}
        run: |
          echo "Refreshing props..."
          curl -sf --max-time 120 \
            -H "Authorization: Bearer $CRON_SECRET" \
            "$VERCEL_APP_URL/api/props?refresh=true" | head -c 300
          echo ""

      - name: Run 3PM zone simulations
        continue-on-error: true
        run: |
          pip install nba_api numpy requests -q
          python3 scripts/sim_3pm.py || py -3 scripts/sim_3pm.py
        env:
          NEXT_PUBLIC_SUPABASE_URL: ${{ secrets.NEXT_PUBLIC_SUPABASE_URL }}
          SUPABASE_SERVICE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}

      # ── Both runs: enrich with fresh defense stats + current lines ─────────

      - name: Enrich props (AI confidence scoring)
        env:
          VERCEL_APP_URL: ${{ secrets.VERCEL_APP_URL }}
          CRON_SECRET: ${{ secrets.CRON_SECRET }}
        run: |
          echo "Running AI enrichment..."
          curl -sf --max-time 300 \
            -H "Authorization: Bearer $CRON_SECRET" \
            "$VERCEL_APP_URL/api/enrich?force=true" | head -c 300
          echo ""
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/daily-stats.yml
git commit -m "feat: add 3PM simulation step to GitHub Action pipeline"
```

---

### Task 5: Confidence Model — Add SimData Interface and ScoringContext Field

**Files:**
- Modify: `lib/confidence.ts` (lines 130–150)

Add the sim data type and context field so the confidence engine can receive simulation results.

- [ ] **Step 1: Add SimData interface after OpponentStatLeak (line 128)**

In `lib/confidence.ts`, add after line 128 (`}`):

```typescript
/** 3PM simulation result from Monte Carlo zone model */
export interface SimThreePm {
  p_over:   number  // probability of hitting over the line
  p_under:  number
  sim_mean: number  // average simulated 3PM
  sim_std:  number
}
```

- [ ] **Step 2: Add simThreePm field to ScoringContext**

In `lib/confidence.ts`, add a new field to the `ScoringContext` interface (after the `awayPace` field, around line 149):

```typescript
  simThreePm?:      SimThreePm | null           // Monte Carlo 3PM simulation result
```

- [ ] **Step 3: Commit**

```bash
git add lib/confidence.ts
git commit -m "feat: add SimThreePm interface and ScoringContext field"
```

---

### Task 6: Confidence Model — Apply Sim Additive Adjustment

**Files:**
- Modify: `lib/confidence.ts` (lines ~1132–1145, ~1497–1517)

Add the simAdj calculation and wire it into the final score formula and reason string.

- [ ] **Step 1: Add simAdj calculation before the final score line**

In `lib/confidence.ts`, add after the `overBiasAdj` line (line 1138) and before the `scoreMax` line (line 1142):

```typescript
  // 3PM zone simulation adjustment: Monte Carlo sim with zone-specific defense
  // produces p(over) — compare to baseline 0.50 to determine sim edge.
  // Only applies to three_pointers props.
  let simAdj = 0
  if (stat_type === 'three_pointers' && ctx.simThreePm) {
    const simEdge = ctx.simThreePm.p_over - 0.50
    if (simEdge > 0.10)      simAdj =  6
    else if (simEdge > 0.05) simAdj =  4
    else if (simEdge > 0.02) simAdj =  2
    else if (simEdge < -0.10) simAdj = -6
    else if (simEdge < -0.05) simAdj = -4
    else if (simEdge < -0.02) simAdj = -2
    // Flip for UNDER picks: if sim favors over, that's bad for an under pick
    if (direction === 'under') simAdj = -simAdj
  }
```

- [ ] **Step 2: Add simAdj to the final score formula**

Modify line 1144 to include `simAdj`:

Change:
```typescript
    adjustedRaw * 100 + consensusAdj * freshness + starBonus + biasAdj + leakAdj + lineMovAdj + oddsMovAdj + minutesTrendAdj + minutesUncertaintyPenalty + overBiasAdj + opponentB2bAdj
```

To:
```typescript
    adjustedRaw * 100 + consensusAdj * freshness + starBonus + biasAdj + leakAdj + lineMovAdj + oddsMovAdj + minutesTrendAdj + minutesUncertaintyPenalty + overBiasAdj + opponentB2bAdj + simAdj
```

- [ ] **Step 3: Add sim info to confidence_reason**

In the `buildReason()` function, add a new section after the sharp money signals block (after line 1516, before the final `return`):

```typescript
  // 11. 3PM simulation note
  if (stat_type === 'three_pointers' && ctx.simThreePm) {
    const pOverPct = (ctx.simThreePm.p_over * 100).toFixed(0)
    const meanStr = ctx.simThreePm.sim_mean.toFixed(1)
    if (ctx.simThreePm.p_over > 0.55) {
      sentences.push(`Zone sim model projects ${meanStr} 3PM avg (${pOverPct}% over) — zone-adjusted defense favors the OVER.`)
    } else if (ctx.simThreePm.p_over < 0.45) {
      sentences.push(`Zone sim model projects ${meanStr} 3PM avg (only ${pOverPct}% over) — zone-adjusted defense limits upside.`)
    } else {
      sentences.push(`Zone sim model projects ${meanStr} 3PM avg (${pOverPct}% over) — neutral zone-defense signal.`)
    }
  }
```

Note: the `buildReason` function needs access to `ctx` and `stat_type`. Check that these are already in scope — `stat_type` comes from `prop.stat_type` which is already available as `stat` or destructured. The `ctx` object needs to be passed to `buildReason`. If it's not currently passed, add it as a parameter:

Update the `buildReason` call at line 1152 to pass `ctx`:
```typescript
  const reason = buildReason(
    prop, gameLogs, fLineValue, hr20, f3, f6, f2, hasLogs, defStats, vsOpp, isHome,
    spread, playerStatus, injuredTeammates, seasonStats, gameTotal, freshness, playerTier,
    ctx.lineMovementDelta ?? null,
    ctx.oddsMovementDelta ?? null,
    opponentDisplayName,
    ctx,  // pass full context for sim data
  )
```

And update the `buildReason` function signature to accept the new parameter:
```typescript
function buildReason(
  prop: Prop, gameLogs: GameLog[], /* ...existing params... */
  opponentDisplayName: string | null,
  ctx?: ScoringContext | null,  // new param
): string {
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd C:/Users/dcho0/nbaiqproject
npx next build 2>&1 | head -30
```

Expected: Build succeeds (or only pre-existing warnings).

- [ ] **Step 5: Commit**

```bash
git add lib/confidence.ts
git commit -m "feat: add 3PM sim additive adjustment to confidence engine"
```

---

### Task 7: Enrich Route — Fetch Sim Data and Pass to Scorer

**Files:**
- Modify: `app/api/enrich/route.ts`

Add `sim_3pm` to the parallel data fetch, build a lookup map, and pass sim data through `ScoringContext`.

- [ ] **Step 1: Add SimThreePm to imports (line ~17)**

In `app/api/enrich/route.ts`, add `SimThreePm` to the import from `@/lib/confidence`:

```typescript
import {
  scoreProps,
  inferPlayerPosition,
  type GameLog,
  type HistoricalLine,
  type TeamDefenseStats,
  type DvpStats,
  type ScoringContext,
  type InjuredTeammate,
  type SeasonStats,
  type PlayerLineBias,
  type OpponentStatLeak,
  type SimThreePm,        // ← add this
} from '@/lib/confidence'
```

- [ ] **Step 2: Add sim_3pm fetch to the Promise.all block (line ~313)**

Add a new entry to the Promise.all destructuring and call:

Change the destructuring to add `{ data: simRows }`:
```typescript
  const [
    allLogRows,
    histRows,
    { data: defRows },
    { data: dvpRows },
    { data: seasonRows },
    { data: biasRows },
    { data: leakRows },
    { data: positionRows },
    openingOddsMap,
    spreadMap,
    injuryMap,
    yesterdayTeams,
    { data: simRows },      // ← add this
  ] = await Promise.all([
    loadPagedGameLogs(),
    loadPagedHistLines(),
    supabase.from('team_defense_stats').select('*'),
    supabase.from('team_defense_vs_position').select('*'),
    supabase.from('player_season_stats').select('*'),
    supabase.from('player_line_bias').select('player_name, stat_type, hit_rate, median_ratio, sample_count'),
    supabase.from('opponent_stat_leaks').select('opponent_team, stat_type, over_hit_rate, median_ratio, sample_count'),
    supabase.from('player_positions').select('player_name, position_group'),
    loadMorningOdds(),
    fetchEspnSpreads(),
    fetchEspnInjuries(),
    fetchYesterdayTeams(),
    supabase.from('sim_3pm').select('player_name, opponent, p_over, p_under, sim_mean, sim_std').eq('game_date', new Date().toISOString().slice(0, 10)),  // ← add this
  ])
```

- [ ] **Step 3: Build simMap after the existing map-building code (after line ~416)**

Add after the `dvpMap` building block:

```typescript
  // Build 3PM simulation map: "player_name|opponent" → SimThreePm
  const simMap = new Map<string, SimThreePm>()
  for (const row of simRows ?? []) {
    simMap.set(`${row.player_name}|${row.opponent}`, {
      p_over:   Number(row.p_over),
      p_under:  Number(row.p_under),
      sim_mean: Number(row.sim_mean),
      sim_std:  Number(row.sim_std),
    })
  }
  console.log(`[/api/enrich] 3PM sim results loaded: ${simMap.size} players`)
```

- [ ] **Step 4: Pass simThreePm in the ScoringContext (line ~520)**

In the main scoring loop where the `ctx` object is built, add the `simThreePm` field:

```typescript
    const ctx: ScoringContext = {
      defStats,
      isHome,
      opponentAbbr,
      spread,
      gameTotal,
      playerStatus,
      injuredTeammates,
      seasonStats,
      historicalLines,
      playerBias:     playerAbbr ? (biasMap.get(`${playerAbbr}|${prop.stat_type}`) ?? null) : null,
      opponentLeak:   opponentAbbr ? (leakMap.get(`${opponentAbbr}|${prop.stat_type}`) ?? null) : null,
      lineMovementDelta,
      oddsMovementDelta,
      dvpStats,
      playerPosition,
      opponentOnB2B,
      homePace,
      awayPace,
      simThreePm:     prop.stat_type === 'three_pointers' && opponentAbbr
                        ? (simMap.get(`${prop.player_name}|${opponentAbbr}`) ?? null)
                        : null,
    }
```

Also add it to the alt-lines ctx (line ~644):

```typescript
      const ctx: ScoringContext = {
        defStats, isHome, opponentAbbr, spread, gameTotal, playerStatus, injuredTeammates,
        seasonStats:    altSeasonStats,
        playerBias:     biasMap.get(`${pseudoProp.player_name}|${pseudoProp.stat_type}`) ?? null,
        opponentLeak:   opponentAbbr ? (leakMap.get(`${opponentAbbr}|${pseudoProp.stat_type}`) ?? null) : null,
        dvpStats:       altDvpStats,
        playerPosition: altPosition,
        opponentOnB2B:  altB2B,
        homePace:       altHomePace,
        awayPace:       altAwayPace,
        simThreePm:     pseudoProp.stat_type === 'three_pointers' && opponentAbbr
                          ? (simMap.get(`${pseudoProp.player_name}|${opponentAbbr}`) ?? null)
                          : null,
      }
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd C:/Users/dcho0/nbaiqproject
npx next build 2>&1 | head -30
```

Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git add app/api/enrich/route.ts
git commit -m "feat: fetch sim_3pm data in enrich and pass to confidence scorer"
```

---

### Task 8: End-to-End Verification

**Files:** None (testing only)

- [ ] **Step 1: Run sim script locally**

```bash
cd C:/Users/dcho0/nbaiqproject
python3 scripts/sim_3pm.py --n-sims 1000
```

Expected: Simulates all players with 3PM props, upserts to `sim_3pm` table.

- [ ] **Step 2: Verify sim_3pm data in Supabase**

Check Supabase dashboard → `sim_3pm` table. Should have rows with today's date, reasonable p_over values (0.20–0.80 range), sim_mean values (1.0–5.0 range for most players).

- [ ] **Step 3: Trigger enrich and verify sim adjustment**

```bash
curl -sf --max-time 300 \
  -H "Authorization: Bearer $CRON_SECRET" \
  "$VERCEL_APP_URL/api/enrich?force=true" | head -c 500
```

Check Vercel logs for: `[/api/enrich] 3PM sim results loaded: N players`

Check a 3PM prop's `confidence_reason` in Supabase — should contain "Zone sim model projects..." text.

- [ ] **Step 4: Compare before/after scores**

Query Supabase for 3PM props and check that confidence scores have shifted by the expected ±2–6 points compared to a run without sim data. No scores should exceed 95 or drop below 18.

- [ ] **Step 5: Trigger GitHub Action manually to test full pipeline**

Go to GitHub repo → Actions → "Daily NBA Stats Refresh" → Run workflow.

Watch the "Run 3PM zone simulations" step. Expected: completes within 5–8 minutes, no errors (or `continue-on-error` handles any).

- [ ] **Step 6: Commit any fixes**

```bash
git add -A
git commit -m "fix: address issues found during e2e verification"
```
