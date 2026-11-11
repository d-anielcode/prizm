"""
Portfolio Backtest
==================
Tests every combination of daily parlay bets to find the most profitable portfolio.

For each day, builds up to MAX_PER_TIER non-overlapping parlays of each tier:
  2-leg  — Safe Pick   (pts_reb_ast_3pm_vol, LOCK+PLAY, no mins filter)
  4-leg  — High Roller (pts_reb_ast_3pm_vol, LOCK+PLAY, 24+ min)
  5-leg  — Jackpot     (pts_reb_ast_3pm_vol, LOCK+PLAY, 24+ min)

Tests all (N2, N4, N5) combos where total parlays per day <= MAX_TOTAL.
Each parlay costs $STAKE. Reports ROI and daily profit for every combo.

Usage:
  py -3 scripts/backtest_portfolio.py --pit-csv pit_output.csv
  py -3 scripts/backtest_portfolio.py  (uses prop_grades from Supabase)
"""

import os, sys, csv, argparse
from collections import defaultdict
from itertools import product

import requests

# ── Credentials ───────────────────────────────────────────────────────────────
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

HEADERS = {
    'apikey': SUPABASE_KEY,
    'Authorization': f'Bearer {SUPABASE_KEY}',
    'Content-Type': 'application/json',
}

def supabase_get_all(table, params='', page=1000):
    rows = []
    offset = 0
    while True:
        url = f'{SUPABASE_URL}/rest/v1/{table}?{params}&limit={page}&offset={offset}'
        r = requests.get(url, headers=HEADERS, timeout=30)
        r.raise_for_status()
        batch = r.json()
        if not batch:
            break
        rows.extend(batch)
        if len(batch) < page:
            break
        offset += page
    return rows

def to_decimal(odds):
    if odds is None:
        return 100 / 130 + 1
    if odds > 0:
        return odds / 100 + 1
    return 100 / abs(odds) + 1

# ── Config ─────────────────────────────────────────────────────────────────────
STAKE       = 5.0
MAX_PER_TIER = 3   # max parlays per tier per day to pre-build
MAX_TOTAL   = 5    # max total parlays in a single portfolio combo

MARKETS_VOL = {'points', 'rebounds', 'assists', 'three_pointers', 'blocks', 'steals'}
VOLATILE    = {'blocks', 'steals'}

TIERS = {
    2: {'markets': MARKETS_VOL, 'tiers': {'LOCK', 'PLAY'}, 'min_mins': 0,  'label': '2-leg Safe'},
    4: {'markets': MARKETS_VOL, 'tiers': {'LOCK', 'PLAY'}, 'min_mins': 24, 'label': '4-leg High Roller'},
    5: {'markets': MARKETS_VOL, 'tiers': {'LOCK', 'PLAY'}, 'min_mins': 24, 'label': '5-leg Jackpot'},
}


def build_parlays_for_day(day_props, legs_needed, cfg, max_count, hist_map, avg_mins_fn, date):
    """Build up to max_count non-overlapping parlays of a given tier for one day."""
    markets   = cfg['markets']
    tiers     = cfg['tiers']
    min_mins  = cfg['min_mins']

    # Eligible pool for this tier
    pool = [
        p for p in day_props
        if p['stat_type'] in markets
        and p['confidence_label'] in tiers
        and p['hit'] is not None
        and (p['stat_type'] not in VOLATILE or p['confidence_label'] == 'LOCK')
    ]
    pool.sort(key=lambda p: p['confidence_score'], reverse=True)

    parlays = []
    used_keys = set()  # player|stat keys used across all parlays this tier

    for _ in range(max_count):
        selected = []
        used_players = set()

        for prop in pool:
            if len(selected) >= legs_needed:
                break
            key = f"{prop['player_name']}|{prop['stat_type']}"
            if key in used_keys:
                continue
            if prop['player_name'] in used_players:
                continue
            avg_mins = avg_mins_fn(prop['player_name'], date)
            if min_mins > 0 and (avg_mins is None or avg_mins < min_mins):
                continue
            selected.append(prop)
            used_players.add(prop['player_name'])

        if len(selected) < legs_needed:
            break  # can't build another full parlay

        # Compute parlay decimal odds + hit
        odds_key_fn = lambda p: f"{p['player_name']}|{p['stat_type']}|{p['game_date']}"
        decimal = 1.0
        for leg in selected:
            odds = hist_map.get(odds_key_fn(leg))
            decimal *= to_decimal(odds)

        hit = all(leg['hit'] is True for leg in selected)
        parlays.append({'decimal': decimal, 'hit': hit})

        # Mark these legs as used for subsequent parlays
        for leg in selected:
            used_keys.add(f"{leg['player_name']}|{leg['stat_type']}")

    return parlays


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--pit-csv', metavar='PATH', default=None,
                        help='Use PIT backtest CSV instead of prop_grades')
    parser.add_argument('--top', type=int, default=20, help='Show top N combos by ROI')
    parser.add_argument('--min-days', type=int, default=30,
                        help='Minimum days with a full portfolio to include combo (default 30)')
    args = parser.parse_args()

    # ── Load grades ────────────────────────────────────────────────────────────
    if args.pit_csv:
        print(f"Loading PIT CSV from {args.pit_csv}...")
        grades_raw = []
        with open(args.pit_csv, newline='', encoding='utf-8') as f:
            for row in csv.DictReader(f):
                grades_raw.append({
                    'game_date':        row['game_date'],
                    'player_name':      row['player_name'],
                    'stat_type':        row['stat_type'],
                    'line':             float(row['line']),
                    'direction':        row['direction'],
                    'confidence_label': row['confidence_label'],
                    'confidence_score': int(row['confidence_score']),
                    'hit':              row['hit'].lower() == 'true',
                })
        grades_raw = [g for g in grades_raw if g['direction'] == 'over']
    else:
        if not SUPABASE_URL or not SUPABASE_KEY:
            print("ERROR: Missing credentials. Use --pit-csv or set SUPABASE env vars.")
            sys.exit(1)
        print("Loading prop_grades...")
        grades_raw = supabase_get_all(
            'prop_grades',
            'select=game_date,player_name,stat_type,line,direction,confidence_label,confidence_score,hit'
            '&confidence_label=not.is.null&direction=eq.over&hit=not.is.null&order=game_date.asc'
        )

    print(f"  {len(grades_raw)} props loaded")

    # Dedup
    dedup = {}
    for p in grades_raw:
        key = f"{p['player_name']}|{p['stat_type']}|{p['game_date']}"
        if key not in dedup or p['confidence_score'] > dedup[key]['confidence_score']:
            dedup[key] = p
    grades = list(dedup.values())

    # ── Load odds ──────────────────────────────────────────────────────────────
    if not args.pit_csv:
        print("Loading prop_history for odds...")
    hist_map = {}
    if not args.pit_csv and SUPABASE_URL:
        hist_raw = supabase_get_all(
            'prop_history',
            'select=game_date,player_name,stat_type,direction,odds&direction=eq.over'
        )
        for r in hist_raw:
            key = f"{r['player_name']}|{r['stat_type']}|{r['game_date']}"
            if key not in hist_map:
                hist_map[key] = r['odds']
        print(f"  {len(hist_map)} odds entries loaded")

    # ── Load game logs for avg minutes ─────────────────────────────────────────
    avg_mins_cache = {}
    logs_by_player = defaultdict(list)

    if not args.pit_csv and SUPABASE_URL:
        print("Loading player_game_logs for avg minutes...")
        logs_raw = supabase_get_all(
            'player_game_logs',
            'select=player_name,game_date,minutes&minutes=not.is.null&order=game_date.asc'
        )
        for r in logs_raw:
            logs_by_player[r['player_name']].append((r['game_date'], float(r['minutes'] or 0)))
        for player in logs_by_player:
            logs_by_player[player].sort(key=lambda x: x[0])
        print(f"  {len(logs_by_player)} players with game logs")

    def get_avg_mins(player, before_date):
        key = f"{player}|{before_date}"
        if key in avg_mins_cache:
            return avg_mins_cache[key]
        logs = logs_by_player.get(player, [])
        prior = [m for d, m in logs if d < before_date][-20:]
        result = sum(prior) / len(prior) if prior else None
        avg_mins_cache[key] = result
        return result

    # If using pit-csv, skip min_mins filter (no logs available)
    if args.pit_csv:
        def get_avg_mins(player, before_date):
            return 30.0  # assume all players qualify — filter handled by PIT data quality

    # ── Group by date ──────────────────────────────────────────────────────────
    by_date = defaultdict(list)
    for p in grades:
        by_date[p['game_date']].append(p)
    dates = sorted(by_date.keys())
    print(f"\n{len(dates)} dates: {dates[0]} to {dates[-1]}")

    # ── Pre-build parlays for every date and tier ──────────────────────────────
    print(f"Building up to {MAX_PER_TIER} parlays/tier/day across {len(dates)} dates...")

    # daily_parlays[date][legs] = list of {decimal, hit}
    daily_parlays = {}
    for date in dates:
        daily_parlays[date] = {}
        for legs, cfg in TIERS.items():
            parlays = build_parlays_for_day(
                by_date[date], legs, cfg, MAX_PER_TIER, hist_map, get_avg_mins, date
            )
            daily_parlays[date][legs] = parlays

    # ── Enumerate all (N2, N4, N5) combinations ────────────────────────────────
    combos = []
    for n2 in range(MAX_PER_TIER + 1):
        for n4 in range(MAX_PER_TIER + 1):
            for n5 in range(MAX_PER_TIER + 1):
                total = n2 + n4 + n5
                if total == 0 or total > MAX_TOTAL:
                    continue
                combos.append((n2, n4, n5))

    print(f"Testing {len(combos)} portfolio combinations...\n")

    results = []
    for (n2, n4, n5) in combos:
        days_played  = 0
        total_staked = 0.0
        total_profit = 0.0
        two_hits = four_hits = five_hits = 0
        two_total = four_total = five_total = 0

        for date in dates:
            p2 = daily_parlays[date][2]
            p4 = daily_parlays[date][4]
            p5 = daily_parlays[date][5]

            # Only count days where we have enough parlays for the full combo
            if len(p2) < n2 or len(p4) < n4 or len(p5) < n5:
                continue

            days_played  += 1
            day_stake     = (n2 + n4 + n5) * STAKE
            total_staked += day_stake
            day_profit    = -day_stake  # start negative (all lose)

            for i in range(n2):
                two_total += 1
                if p2[i]['hit']:
                    two_hits  += 1
                    day_profit += STAKE * p2[i]['decimal']
            for i in range(n4):
                four_total += 1
                if p4[i]['hit']:
                    four_hits  += 1
                    day_profit += STAKE * p4[i]['decimal']
            for i in range(n5):
                five_total += 1
                if p5[i]['hit']:
                    five_hits  += 1
                    day_profit += STAKE * p5[i]['decimal']

            total_profit += day_profit

        if days_played < args.min_days:
            continue

        roi       = round(total_profit / total_staked * 100, 1) if total_staked > 0 else None
        profit_pd = round(total_profit / days_played, 2) if days_played > 0 else None
        daily_cost = (n2 + n4 + n5) * STAKE

        results.append({
            'n2': n2, 'n4': n4, 'n5': n5,
            'label': f"{n2}x2leg + {n4}x4leg + {n5}x5leg",
            'daily_cost': daily_cost,
            'days':       days_played,
            'roi':        roi,
            'profit_pd':  profit_pd,
            'total_profit': round(total_profit, 2),
            'two_hit_pct':  round(two_hits  / two_total  * 100, 1) if two_total  > 0 else None,
            'four_hit_pct': round(four_hits / four_total * 100, 1) if four_total > 0 else None,
            'five_hit_pct': round(five_hits / five_total * 100, 1) if five_total > 0 else None,
        })

    # ── Print results ──────────────────────────────────────────────────────────
    results.sort(key=lambda r: r['roi'] if r['roi'] is not None else -999, reverse=True)

    print(f"TOP {args.top} PORTFOLIOS BY ROI  (min {args.min_days} days, ${STAKE}/parlay)")
    print(f"{'Portfolio':<30} {'$/day':>6} {'Days':>5} {'ROI%':>7} {'P/Day':>7} {'Total P/L':>10}  2L%  4L%  5L%")
    print("-" * 100)

    for r in results[:args.top]:
        two_str  = f"{r['two_hit_pct']:>4.0f}%" if r['two_hit_pct']  is not None else '  — '
        four_str = f"{r['four_hit_pct']:>4.0f}%" if r['four_hit_pct'] is not None else '  — '
        five_str = f"{r['five_hit_pct']:>4.0f}%" if r['five_hit_pct'] is not None else '  — '
        print(
            f"  {r['label']:<28} ${r['daily_cost']:>4.0f}  {r['days']:>5} "
            f"  {r['roi']:>+6.1f}%  ${r['profit_pd']:>+6.2f}  ${r['total_profit']:>+8.2f}  "
            f"{two_str} {four_str} {five_str}"
        )

    print()

    # ── Best per daily budget ──────────────────────────────────────────────────
    print("BEST PORTFOLIO PER DAILY BUDGET")
    print(f"{'Budget/day':<12} {'Portfolio':<30} {'ROI%':>7} {'P/Day':>8}")
    print("-" * 65)

    by_budget = defaultdict(list)
    for r in results:
        by_budget[r['daily_cost']].append(r)

    for budget in sorted(by_budget.keys()):
        best = max(by_budget[budget], key=lambda r: r['roi'] if r['roi'] is not None else -999)
        print(f"  ${budget:<10.0f} {best['label']:<30} {best['roi']:>+6.1f}%  ${best['profit_pd']:>+6.2f}/day")

    print("\nDone.")


if __name__ == '__main__':
    main()
