"""
Parlay Backtest — Python version
=================================
Tests different parlay configurations against historical prop_grades data.

New configs being tested (vs existing TS backtest):
  - LOCK-only pool (no PLAY)
  - blocks + steals included (LOCK-only for volatile stats)
  - minimum score filter (≥74, ≥76)
  - 2-leg parlays

Usage:
  py -3.13 scripts/backtest_parlay.py
  py -3.13 scripts/backtest_parlay.py --source real   (2026-02-04+)
  py -3.13 scripts/backtest_parlay.py --top 20        (show top N configs)
"""

import os, sys, argparse
from collections import defaultdict

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
if not SUPABASE_URL or not SUPABASE_KEY:
    print("ERROR: Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_KEY")
    sys.exit(1)

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
        return 100 / 130 + 1  # default -130
    if odds > 0:
        return odds / 100 + 1
    return 100 / abs(odds) + 1

# ── Configs ───────────────────────────────────────────────────────────────────

MARKET_SETS = {
    'pts_reb_3pm':         ['points', 'rebounds', 'three_pointers'],
    'pts_reb_ast_3pm':     ['points', 'rebounds', 'assists', 'three_pointers'],
    'pts_reb_ast':         ['points', 'rebounds', 'assists'],
    # New: include volatile stats at LOCK-only
    'pts_reb_ast_3pm_blk': ['points', 'rebounds', 'assists', 'three_pointers', 'blocks'],
    'pts_reb_ast_3pm_stl': ['points', 'rebounds', 'assists', 'three_pointers', 'steals'],
    'pts_reb_ast_3pm_vol': ['points', 'rebounds', 'assists', 'three_pointers', 'blocks', 'steals'],
    'all_with_vol':        ['points', 'rebounds', 'assists', 'three_pointers', 'blocks', 'steals', 'pra'],
}

# For volatile stats (blocks/steals), only allow LOCK-level picks regardless of config tier
VOLATILE_STATS = {'blocks', 'steals'}

# Configs to test
CONFIGS = []

# 1. Baseline existing configs (mirrors TS backtest)
for legs in [2, 3, 4]:
    for market in ['pts_reb_3pm', 'pts_reb_ast_3pm']:
        for tiers in [['LOCK', 'PLAY'], ['LOCK']]:
            for min_score in [0, 74, 76]:
                tier_label = '+'.join(tiers)
                score_label = f'score>={min_score}' if min_score else 'no_score_filter'
                CONFIGS.append({
                    'id':        f'{legs}leg_{market}_{tier_label}_{score_label}',
                    'legs':      legs,
                    'markets':   market,
                    'tiers':     set(tiers),
                    'min_score': min_score,
                    'min_mins':  0,
                })

# 2. New configs: with volatile stats (blocks/steals, LOCK-only for volatile)
for legs in [2, 3]:
    for market in ['pts_reb_ast_3pm_blk', 'pts_reb_ast_3pm_stl', 'pts_reb_ast_3pm_vol']:
        for tiers in [['LOCK', 'PLAY'], ['LOCK']]:
            for min_score in [0, 74]:
                tier_label = '+'.join(tiers)
                score_label = f'score>={min_score}' if min_score else 'no_score_filter'
                CONFIGS.append({
                    'id':        f'{legs}leg_{market}_{tier_label}_{score_label}_vol_lock_only',
                    'legs':      legs,
                    'markets':   market,
                    'tiers':     set(tiers),
                    'min_score': min_score,
                    'min_mins':  0,
                    'volatile_lock_only': True,  # volatile stats use LOCK regardless of tier setting
                })

# 3. Minutes-filtered configs (24+ mins, mirrors PREMIUM/JACKPOT)
for legs in [3, 4, 5]:
    for market in ['pts_reb_ast_3pm', 'pts_reb_ast_3pm_vol']:
        for tiers in [['LOCK', 'PLAY'], ['LOCK']]:
            CONFIGS.append({
                'id':        f'{legs}leg_{market}_{"+".join(tiers)}_24mins',
                'legs':      legs,
                'markets':   market,
                'tiers':     set(tiers),
                'min_score': 0,
                'min_mins':  24,
            })

STAKE = 5.0


def build_parlay(pool, used, legs_needed, min_mins=0, volatile_lock_only=False):
    """Greedily pick legs from pool. Returns list of props or None."""
    selected = []
    used_players = set()

    for prop in pool:
        if len(selected) >= legs_needed:
            break
        key = f"{prop['player_name']}|{prop['stat_type']}"
        if key in used:
            continue
        if prop['player_name'] in used_players:
            continue
        if min_mins > 0 and (prop.get('avg_mins') is None or prop['avg_mins'] < min_mins):
            continue
        # Volatile stats: require LOCK regardless of pool tier setting
        if volatile_lock_only and prop['stat_type'] in VOLATILE_STATS:
            if prop['confidence_label'] != 'LOCK':
                continue
        selected.append(prop)
        used_players.add(prop['player_name'])

    if len(selected) < legs_needed:
        return None
    return selected


def run_config(config, by_date, sorted_dates):
    allowed_markets = set(MARKET_SETS[config['markets']])
    allowed_tiers   = config['tiers']
    min_score       = config.get('min_score', 0)
    min_mins        = config.get('min_mins', 0)
    volatile_lock   = config.get('volatile_lock_only', False)
    legs_needed     = config['legs']

    days_played = 0
    total_parlays = 0
    total_hits = 0
    total_staked = 0.0
    total_profit = 0.0
    total_decimal = 0.0

    for date in sorted_dates:
        day_props = by_date.get(date, [])

        pool = [
            p for p in day_props
            if p['stat_type'] in allowed_markets
            and p['confidence_label'] in allowed_tiers
            and p['hit'] is not None
            and (min_score == 0 or p['confidence_score'] >= min_score)
        ]
        pool.sort(key=lambda p: p['confidence_score'], reverse=True)

        used = set()
        parlay = build_parlay(pool, used, legs_needed, min_mins, volatile_lock)
        if parlay is None:
            continue

        days_played += 1
        total_parlays += 1
        total_staked += STAKE

        for leg in parlay:
            used.add(f"{leg['player_name']}|{leg['stat_type']}")

        decimals = [to_decimal(leg['odds']) for leg in parlay]
        parlay_dec = 1.0
        for d in decimals:
            parlay_dec *= d
        total_decimal += parlay_dec

        hit = all(leg['hit'] is True for leg in parlay)
        profit = STAKE * parlay_dec - STAKE if hit else -STAKE
        if hit:
            total_hits += 1
        total_profit += profit

    hit_rate = round(total_hits / total_parlays * 100, 1) if total_parlays > 0 else None
    roi      = round(total_profit / total_staked * 100, 1) if total_staked > 0 else None
    avg_mult = round(total_decimal / total_parlays, 2) if total_parlays > 0 else None

    return {
        'id':           config['id'],
        'legs':         legs_needed,
        'markets':      config['markets'],
        'tiers':        sorted(config['tiers']),
        'min_score':    min_score,
        'min_mins':     min_mins,
        'days_played':  days_played,
        'total_parlays':total_parlays,
        'hits':         total_hits,
        'hit_rate':     hit_rate,
        'avg_mult':     avg_mult,
        'total_staked': round(total_staked, 2),
        'total_profit': round(total_profit, 2),
        'roi':          roi,
        'profit_per_day': round(total_profit / days_played, 2) if days_played > 0 else None,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', default='real', choices=['real', 'all'],
                        help='real = 2026-02-04+; all = all dates')
    parser.add_argument('--top', type=int, default=30, help='Show top N configs by ROI')
    args = parser.parse_args()

    REAL_START = '2026-02-04'

    print("Loading prop_grades...")
    grades_raw = supabase_get_all(
        'prop_grades',
        'select=game_date,player_name,stat_type,line,direction,confidence_label,confidence_score,hit'
        '&confidence_label=not.is.null&direction=eq.over&hit=not.is.null'
        '&order=game_date.asc'
    )
    print(f"  {len(grades_raw)} graded props loaded")

    print("Loading prop_history for odds...")
    hist_raw = supabase_get_all(
        'prop_history',
        'select=game_date,player_name,stat_type,direction,odds&direction=eq.over'
    )
    hist_map = {}
    for r in hist_raw:
        key = f"{r['player_name']}|{r['stat_type']}|{r['game_date']}"
        if key not in hist_map:
            hist_map[key] = r['odds']
    print(f"  {len(hist_map)} odds entries loaded")

    print("Loading player_game_logs for avg minutes...")
    logs_raw = supabase_get_all(
        'player_game_logs',
        'select=player_name,game_date,minutes&minutes=not.is.null&order=game_date.asc'
    )
    logs_by_player = defaultdict(list)
    for r in logs_raw:
        logs_by_player[r['player_name']].append((r['game_date'], float(r['minutes'] or 0)))
    # Sort each player's logs ascending
    for player in logs_by_player:
        logs_by_player[player].sort(key=lambda x: x[0])
    print(f"  {len(logs_by_player)} players with game logs")

    # Precompute avg minutes per player per date (last 20 prior games, no lookahead)
    avg_mins_cache = {}
    def get_avg_mins(player, before_date):
        key = f"{player}|{before_date}"
        if key in avg_mins_cache:
            return avg_mins_cache[key]
        logs = logs_by_player.get(player, [])
        prior = [m for d, m in logs if d < before_date][-20:]
        result = sum(prior) / len(prior) if prior else None
        avg_mins_cache[key] = result
        return result

    # Annotate grades
    annotated = []
    for g in grades_raw:
        odds_key = f"{g['player_name']}|{g['stat_type']}|{g['game_date']}"
        annotated.append({
            **g,
            'odds':    hist_map.get(odds_key),
            'avg_mins': get_avg_mins(g['player_name'], g['game_date']),
        })

    # Dedup: keep highest confidence per player|stat|date
    dedup = {}
    for p in annotated:
        key = f"{p['player_name']}|{p['stat_type']}|{p['game_date']}"
        if key not in dedup or p['confidence_score'] > dedup[key]['confidence_score']:
            dedup[key] = p
    annotated = list(dedup.values())

    # Group by date
    by_date = defaultdict(list)
    for p in annotated:
        by_date[p['game_date']].append(p)

    all_dates = sorted(by_date.keys())
    if args.source == 'real':
        dates = [d for d in all_dates if d >= REAL_START]
    else:
        dates = all_dates

    print(f"\nRunning {len(CONFIGS)} configs across {len(dates)} dates ({dates[0]} to {dates[-1]})...")
    print("=" * 80)

    results = []
    for cfg in CONFIGS:
        result = run_config(cfg, by_date, dates)
        results.append(result)

    # Sort by ROI descending
    results.sort(key=lambda r: r['roi'] if r['roi'] is not None else -999, reverse=True)

    # ── Print results ──────────────────────────────────────────────────────────
    print(f"\nTOP {args.top} CONFIGS BY ROI ({args.source} dates, 1 parlay/day)")
    print(f"{'Config':<55} {'Legs':>4} {'Days':>5} {'Hits':>5} {'Hit%':>6} {'AvgX':>6} {'ROI%':>7} {'P/Day':>7}")
    print("-" * 105)

    shown = 0
    for r in results:
        if shown >= args.top:
            break
        if r['days_played'] < 10:  # skip configs with too few data points
            continue
        tiers_str = '+'.join(r['tiers'])
        score_str = f" s>={r['min_score']}" if r['min_score'] else ''
        mins_str  = f" {r['min_mins']}+min" if r['min_mins'] else ''
        label = f"{r['markets']} {tiers_str}{score_str}{mins_str}"
        print(f"{label:<55} {r['legs']:>4} {r['days_played']:>5} {r['hits']:>5} "
              f"{r['hit_rate']:>5.1f}% {r['avg_mult']:>6.2f}x {r['roi']:>+6.1f}% "
              f"{r['profit_per_day']:>+6.2f}")
        shown += 1

    # ── Per-stat hit rates in parlay legs ──────────────────────────────────────
    print("\n\nPER-STAT HIT RATES (across all graded LOCK+PLAY props in date range)")
    print(f"{'Stat':<20} {'Label':<8} {'Hits':>6} {'Total':>6} {'Hit%':>7}")
    print("-" * 55)

    stat_hits = defaultdict(lambda: {'hits': 0, 'total': 0})
    for p in annotated:
        if p['game_date'] not in set(dates):
            continue
        if p['hit'] is None:
            continue
        if p['confidence_label'] not in ('LOCK', 'PLAY'):
            continue
        key = f"{p['stat_type']}|{p['confidence_label']}"
        stat_hits[key]['total'] += 1
        if p['hit']:
            stat_hits[key]['hits'] += 1

    for key in sorted(stat_hits.keys()):
        stat, label = key.split('|')
        h = stat_hits[key]
        pct = h['hits'] / h['total'] * 100 if h['total'] > 0 else 0
        print(f"  {stat:<18} {label:<8} {h['hits']:>6} {h['total']:>6} {pct:>6.1f}%")

    # ── Highlight key comparisons ──────────────────────────────────────────────
    print("\n\nKEY COMPARISONS (baseline vs new configs, 3-leg 1-parlay/day)")
    print(f"{'Config':<65} {'Hit%':>6} {'ROI%':>7} {'Days':>5}")
    print("-" * 90)

    key_ids = [
        ('BASELINE', '3leg_pts_reb_ast_3pm_LOCK+PLAY_no_score_filter'),
        ('LOCK-only', '3leg_pts_reb_ast_3pm_LOCK_no_score_filter'),
        ('LOCK score>=74', '3leg_pts_reb_ast_3pm_LOCK_score>=74'),
        ('LOCK score>=76', '3leg_pts_reb_ast_3pm_LOCK_score>=76'),
        ('LOCK+blocks', '3leg_pts_reb_ast_3pm_blk_LOCK_no_score_filter_vol_lock_only'),
        ('LOCK+steals', '3leg_pts_reb_ast_3pm_stl_LOCK_no_score_filter_vol_lock_only'),
        ('LOCK+blk+stl', '3leg_pts_reb_ast_3pm_vol_LOCK_no_score_filter_vol_lock_only'),
        ('2-leg LOCK-only', '2leg_pts_reb_ast_3pm_LOCK_no_score_filter'),
        ('2-leg LOCK+blk+stl', '2leg_pts_reb_ast_3pm_vol_LOCK_no_score_filter_vol_lock_only'),
    ]
    result_map = {r['id']: r for r in results}
    for label, rid in key_ids:
        r = result_map.get(rid)
        if r and r['hit_rate'] is not None and r['roi'] is not None:
            print(f"  {label:<63} {r['hit_rate']:>5.1f}% {r['roi']:>+6.1f}% {r['days_played']:>5}")
        elif r:
            print(f"  {label:<63}   n/a     n/a  {r['days_played']:>5} (too few days)")
        else:
            print(f"  {label:<63} (not found: {rid})")

    print("\nDone.")


if __name__ == '__main__':
    main()
