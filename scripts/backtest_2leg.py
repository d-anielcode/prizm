"""
2-Leg Parlay Optimization
==========================
Tests different configurations for the 2-leg "Safe Pick" to maximize hit rate.
"""

import os, sys
from collections import defaultdict
import requests

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
HEADERS = { 'apikey': SUPABASE_KEY, 'Authorization': f'Bearer {SUPABASE_KEY}', 'Content-Type': 'application/json' }

def supabase_get_all(table, params='', page=1000):
    rows, offset = [], 0
    while True:
        url = f'{SUPABASE_URL}/rest/v1/{table}?{params}&limit={page}&offset={offset}'
        r = requests.get(url, headers=HEADERS, timeout=30)
        r.raise_for_status()
        batch = r.json()
        if not batch: break
        rows.extend(batch)
        if len(batch) < page: break
        offset += page
    return rows

def to_decimal(odds):
    if odds is None: return 100/130 + 1
    return odds/100 + 1 if odds > 0 else 100/abs(odds) + 1

STAKE = 5.0
MARKETS = {'points', 'rebounds', 'assists', 'three_pointers', 'blocks', 'steals'}
VOLATILE = {'blocks', 'steals'}
SAFE_STATS = {'points', 'rebounds', 'assists', 'three_pointers'}
MAX_FAVORITE_ODDS = -150


def main():
    print("Loading prop_grades...")
    grades_raw = supabase_get_all(
        'prop_grades',
        'select=id,game_date,player_name,stat_type,line,direction,confidence_label,confidence_score,hit'
        '&confidence_label=not.is.null&direction=eq.over&hit=not.is.null&order=id.asc'
    )
    print(f"  {len(grades_raw)} props loaded")

    dedup = {}
    for p in grades_raw:
        key = f"{p['player_name']}|{p['stat_type']}|{p['game_date']}"
        if key not in dedup or p['confidence_score'] > dedup[key]['confidence_score']:
            dedup[key] = p
    grades = list(dedup.values())

    print("Loading prop_history for odds...")
    hist_map = {}
    hist_raw = supabase_get_all('prop_history', 'select=game_date,player_name,stat_type,direction,odds,id&direction=eq.over&order=id.asc')
    for r in hist_raw:
        key = f"{r['player_name']}|{r['stat_type']}|{r['game_date']}"
        hist_map[key] = r['odds']
    print(f"  {len(hist_map)} odds entries loaded")

    print("Loading player_game_logs for avg minutes...")
    logs_by_player = defaultdict(list)
    logs_raw = supabase_get_all('player_game_logs', 'select=player_name,game_date,minutes&minutes=not.is.null&order=id.asc')
    for r in logs_raw:
        logs_by_player[r['player_name']].append((r['game_date'], float(r['minutes'] or 0)))
    for p in logs_by_player: logs_by_player[p].sort(key=lambda x: x[0])
    print(f"  {len(logs_by_player)} players")

    avg_cache = {}
    def get_avg_mins(player, before_date):
        ck = f"{player}|{before_date}"
        if ck in avg_cache: return avg_cache[ck]
        logs = logs_by_player.get(player, [])
        prior = [m for d, m in logs if d < before_date][-20:]
        result = sum(prior)/len(prior) if prior else None
        avg_cache[ck] = result
        return result

    by_date = defaultdict(list)
    for p in grades: by_date[p['game_date']].append(p)
    dates = sorted(by_date.keys())
    print(f"\n{len(dates)} dates: {dates[0]} to {dates[-1]}")

    # ── Define 2L configurations to test ──────────────────────────────────────
    configs = [
        {
            'name': 'CURRENT (any LOCK/PLAY, no min filter)',
            'tiers': ['LOCK', 'PLAY'],
            'min_mins': None,
            'stats': MARKETS,
            'exclude_volatile': False,
        },
        {
            'name': 'LOCKs only',
            'tiers': ['LOCK'],
            'min_mins': None,
            'stats': MARKETS,
            'exclude_volatile': False,
        },
        {
            'name': 'LOCKs only + 24min',
            'tiers': ['LOCK'],
            'min_mins': 24,
            'stats': MARKETS,
            'exclude_volatile': False,
        },
        {
            'name': 'LOCK/PLAY + 24min',
            'tiers': ['LOCK', 'PLAY'],
            'min_mins': 24,
            'stats': MARKETS,
            'exclude_volatile': False,
        },
        {
            'name': 'LOCK/PLAY + 28min',
            'tiers': ['LOCK', 'PLAY'],
            'min_mins': 28,
            'stats': MARKETS,
            'exclude_volatile': False,
        },
        {
            'name': 'LOCKs only + 28min',
            'tiers': ['LOCK'],
            'min_mins': 28,
            'stats': MARKETS,
            'exclude_volatile': False,
        },
        {
            'name': 'Safe stats only (no BLK/STL)',
            'tiers': ['LOCK', 'PLAY'],
            'min_mins': None,
            'stats': SAFE_STATS,
            'exclude_volatile': True,
        },
        {
            'name': 'Safe stats + LOCKs only',
            'tiers': ['LOCK'],
            'min_mins': None,
            'stats': SAFE_STATS,
            'exclude_volatile': True,
        },
        {
            'name': 'Safe stats + 24min',
            'tiers': ['LOCK', 'PLAY'],
            'min_mins': 24,
            'stats': SAFE_STATS,
            'exclude_volatile': True,
        },
        {
            'name': 'Safe stats + LOCKs + 24min',
            'tiers': ['LOCK'],
            'min_mins': 24,
            'stats': SAFE_STATS,
            'exclude_volatile': True,
        },
        {
            'name': 'Safe stats + LOCKs + 28min',
            'tiers': ['LOCK'],
            'min_mins': 28,
            'stats': SAFE_STATS,
            'exclude_volatile': True,
        },
        {
            'name': 'Top conf only (score >= 75)',
            'tiers': ['LOCK', 'PLAY'],
            'min_mins': None,
            'stats': MARKETS,
            'exclude_volatile': False,
            'min_score': 75,
        },
        {
            'name': 'Top conf + 24min',
            'tiers': ['LOCK', 'PLAY'],
            'min_mins': 24,
            'stats': MARKETS,
            'exclude_volatile': False,
            'min_score': 75,
        },
        {
            'name': 'LOCKs + safe stats + score>=75',
            'tiers': ['LOCK'],
            'min_mins': None,
            'stats': SAFE_STATS,
            'exclude_volatile': True,
            'min_score': 75,
        },
        {
            'name': 'LOCKs + safe + score>=75 + 24min',
            'tiers': ['LOCK'],
            'min_mins': 24,
            'stats': SAFE_STATS,
            'exclude_volatile': True,
            'min_score': 75,
        },
    ]

    MIN_LINE = {
        'points': 10.5, 'rebounds': 3.5, 'three_pointers': 1.5,
        'assists': 2.5, 'blocks': 0.5, 'steals': 0.5,
    }

    print("\n" + "="*100)
    print(f"{'2-LEG PARLAY CONFIGURATION OPTIMIZATION':^100}")
    print(f"{'Filter: MAX -150 | $5 stake | Full overlap':^100}")
    print("="*100)

    results = []

    for cfg in configs:
        hits = 0
        misses = 0
        days_filled = 0
        days_total = 0
        spent = 0
        won = 0
        # Track individual leg hit rates
        leg_hits = 0
        leg_total = 0

        for date in dates:
            days_total += 1
            all_props = by_date[date]

            # Apply odds filter
            pool_props = []
            for p in all_props:
                odds_key = f"{p['player_name']}|{p['stat_type']}|{p['game_date']}"
                odds = hist_map.get(odds_key)
                if odds is not None and odds < MAX_FAVORITE_ODDS:
                    continue
                pool_props.append(p)

            # Apply config filters
            filtered = []
            for p in pool_props:
                if p['confidence_label'] not in cfg['tiers']: continue
                if p['stat_type'] not in cfg['stats']: continue
                if (p['line'] or 0) < (MIN_LINE.get(p['stat_type'], 0)): continue
                if cfg.get('min_score') and p['confidence_score'] < cfg['min_score']: continue
                if cfg['min_mins'] is not None:
                    avg = get_avg_mins(p['player_name'], date)
                    if avg is not None and avg < cfg['min_mins']: continue
                filtered.append(p)

            pool = sorted(filtered, key=lambda p: (p['confidence_score'], p['player_name']), reverse=True)

            # Pick 2 legs (unique players)
            selected = []
            used = set()
            for p in pool:
                if len(selected) >= 2: break
                if p['player_name'] in used: continue
                if p['hit'] is None: continue
                selected.append(p)
                used.add(p['player_name'])

            if len(selected) < 2: continue

            days_filled += 1
            spent += STAKE

            # Track individual legs
            for leg in selected:
                leg_total += 1
                if leg['hit']: leg_hits += 1

            # Evaluate parlay
            all_hit = all(l['hit'] for l in selected)
            if all_hit:
                hits += 1
                decimal = 1.0
                for l in selected:
                    odds = hist_map.get(f"{l['player_name']}|{l['stat_type']}|{l['game_date']}")
                    decimal *= to_decimal(odds)
                won += STAKE * decimal
            else:
                misses += 1

        hit_rate = hits / days_filled * 100 if days_filled > 0 else 0
        leg_rate = leg_hits / leg_total * 100 if leg_total > 0 else 0
        roi = (won - spent) / spent * 100 if spent > 0 else 0
        dpd = (won - spent) / days_filled if days_filled > 0 else 0

        results.append({
            'name': cfg['name'],
            'days': days_filled,
            'hits': hits,
            'hit_rate': hit_rate,
            'leg_rate': leg_rate,
            'roi': roi,
            'dpd': dpd,
            'pl': won - spent,
        })

    # Sort by hit rate
    results.sort(key=lambda x: x['hit_rate'], reverse=True)

    print(f"\n  {'Configuration':<38s} {'Days':>5s} {'Hits':>6s} {'Hit%':>7s} {'LegHit%':>8s} {'ROI':>8s} {'$/day':>8s} {'P/L':>8s}")
    print(f"  {'-'*36}  {'-'*5} {'-'*6} {'-'*7} {'-'*8} {'-'*8} {'-'*8} {'-'*8}")
    for r in results:
        print(f"  {r['name']:<38s} {r['days']:5d} {r['hits']:4d}/{r['days']:<3d} {r['hit_rate']:6.1f}% {r['leg_rate']:7.1f}% {r['roi']:+7.1f}% {r['dpd']:+7.2f} {r['pl']:+8.0f}")

    print(f"\n  * LegHit% = individual leg hit rate (how often each single pick hits)")
    print(f"  * Hit% = parlay hit rate (both legs hit)")
    print(f"  * Theoretical: if each leg hits at LegHit%, parlay should hit at LegHit%^2")
    print()
    for r in results[:5]:
        theoretical = (r['leg_rate']/100)**2 * 100
        print(f"    {r['name']:<38s}  Leg:{r['leg_rate']:.1f}%  Theoretical 2L:{theoretical:.1f}%  Actual:{r['hit_rate']:.1f}%")

    print("="*100)


if __name__ == '__main__':
    main()
