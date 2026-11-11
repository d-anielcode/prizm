"""
Odds Filter Backtest
=====================
Compares parlay performance WITH vs WITHOUT a -150 max favorite odds filter.
Tests the standard portfolio: 1x 2-leg + 1x 4-leg + 1x 5-leg ($5 each)
Both use full overlap (current best strategy).
"""

import os, sys
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

def pick_parlay(pool, n_legs, min_mins_fn=None, date=None):
    selected = []
    used_players = set()
    for p in pool:
        if len(selected) >= n_legs: break
        if p['player_name'] in used_players: continue
        if p['hit'] is None: continue
        if p['stat_type'] not in MARKETS: continue
        if p['stat_type'] in VOLATILE and p['confidence_label'] != 'LOCK': continue
        if p['confidence_label'] not in ('LOCK', 'PLAY'): continue
        if min_mins_fn and date:
            avg = min_mins_fn(p['player_name'], date)
            if avg is not None and avg < 24: continue
        selected.append(p)
        used_players.add(p['player_name'])
    if len(selected) < n_legs: return None
    return selected

def evaluate_parlay(legs, hist_map):
    decimal = 1.0
    for l in legs:
        odds = hist_map.get(f"{l['player_name']}|{l['stat_type']}|{l['game_date']}")
        decimal *= to_decimal(odds)
    hit = all(l['hit'] is True for l in legs)
    return decimal, hit


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
        # Always overwrite — sorted by cached_at asc, so last write = most recent snapshot
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

    # ── Test with different odds filters ──────────────────────────────────────
    filters = [
        ('NO FILTER',           None),
        ('MAX -165',            -165),
        ('MAX -160',            -160),
        ('MAX -155',            -155),
        ('MAX -150',            -150),
        ('MAX -140',            -140),
        ('MAX -130',            -130),
    ]

    from itertools import combinations

    # Tiers: 2-leg (no min mins), 3-leg (no min mins), 4-leg (24+ mins), 5-leg (24+ mins)
    tier_defs = [(2, False), (3, False), (4, True), (5, True)]
    tier_names = ['2L', '3L', '4L', '5L']

    # All combos: singles, pairs, triples, and all-4
    all_combos = []
    for size in range(1, len(tier_defs) + 1):
        for combo in combinations(range(len(tier_defs)), size):
            all_combos.append(combo)

    print("\n" + "="*100)
    print(f"{'TIER COMBINATION x ODDS FILTER COMPARISON':^100}")
    print(f"{'Full overlap, $5/parlay, partial days included':^100}")
    print("="*100)

    # Pre-compute tier results for each (filter, date)
    all_results = []  # list of (filter_label, combo_label, days, roi, dpd, pl)

    for label, max_fav in filters:
        # Build per-date tier outcomes for this filter
        daily_tiers = {}  # date -> {tier_idx: (decimal, hit)}

        for date in dates:
            all_props = by_date[date]

            if max_fav is not None:
                pool_props = []
                for p in all_props:
                    odds_key = f"{p['player_name']}|{p['stat_type']}|{p['game_date']}"
                    odds = hist_map.get(odds_key)
                    if odds is not None and odds < max_fav:
                        continue
                    pool_props.append(p)
            else:
                pool_props = all_props

            pool = sorted(pool_props, key=lambda p: (p['confidence_score'], p['player_name']), reverse=True)

            tier_results = {}
            for tier_idx, (n_legs, use_min_mins) in enumerate(tier_defs):
                min_fn = get_avg_mins if use_min_mins else None
                legs = pick_parlay(pool, n_legs, min_fn, date)
                if legs is None: continue
                decimal, hit = evaluate_parlay(legs, hist_map)
                tier_results[tier_idx] = (decimal, hit)

            if tier_results:
                daily_tiers[date] = tier_results

        # Now evaluate every combo
        for combo in all_combos:
            spent = 0
            won = 0
            days = 0
            hits_by_tier = [0] * len(tier_defs)
            total_by_tier = [0] * len(tier_defs)

            for date, tier_results in daily_tiers.items():
                # Only count days where at least one tier in this combo filled
                day_spent = 0
                day_won = 0
                for t in combo:
                    if t not in tier_results: continue
                    decimal, hit = tier_results[t]
                    day_spent += STAKE
                    total_by_tier[t] += 1
                    if hit:
                        day_won += STAKE * decimal
                        hits_by_tier[t] += 1

                if day_spent > 0:
                    spent += day_spent
                    won += day_won
                    days += 1

            if days == 0: continue
            roi = (won - spent) / spent * 100
            dpd = (won - spent) / days
            pl = won - spent
            combo_label = '+'.join(tier_names[t] for t in combo)

            all_results.append((label, combo_label, days, roi, dpd, pl, hits_by_tier, total_by_tier))

    # ── Print by combo size ───────────────────────────────────────────────────
    for size, size_label in [(1, 'SINGLE TIER'), (2, 'TWO-TIER COMBOS'), (3, 'THREE-TIER COMBOS'), (4, 'ALL FOUR TIERS')]:
        relevant = [r for r in all_results if len(r[1].split('+')) == size]
        if not relevant: continue

        print(f"\n{'='*100}")
        print(f"  {size_label}")
        print(f"{'='*100}")
        print(f"  {'Filter':<12s} {'Combo':<16s} {'Days':>5s} {'ROI':>8s} {'$/day':>8s} {'P/L':>8s}   Hit rates per tier")
        print(f"  {'-'*10}  {'-'*14}  {'-'*5} {'-'*8} {'-'*8} {'-'*8}   {'-'*30}")

        # Sort by ROI descending
        for r in sorted(relevant, key=lambda x: x[3], reverse=True):
            label, combo_label, days, roi, dpd, pl, hits, totals = r
            hit_strs = []
            for t in range(len(tier_defs)):
                if totals[t] > 0:
                    hit_strs.append(f"{tier_names[t]}:{hits[t]}/{totals[t]}({hits[t]/totals[t]*100:.0f}%)")
            hit_info = '  '.join(hit_strs) if hit_strs else '-'
            print(f"  {label:<12s} {combo_label:<16s} {days:5d} {roi:+7.1f}% {dpd:+7.2f} {pl:+8.0f}   {hit_info}")

    # ── Top 10 overall ────────────────────────────────────────────────────────
    print(f"\n{'='*100}")
    print(f"  TOP 15 COMBINATIONS BY ROI")
    print(f"{'='*100}")
    print(f"  {'#':>3s}  {'Filter':<12s} {'Combo':<16s} {'Days':>5s} {'ROI':>8s} {'$/day':>8s} {'P/L':>8s}")
    print(f"  {'-'*3}  {'-'*10}  {'-'*14}  {'-'*5} {'-'*8} {'-'*8} {'-'*8}")
    for i, r in enumerate(sorted(all_results, key=lambda x: x[3], reverse=True)[:15], 1):
        label, combo_label, days, roi, dpd, pl, _, _ = r
        print(f"  {i:3d}  {label:<12s} {combo_label:<16s} {days:5d} {roi:+7.1f}% {dpd:+7.2f} {pl:+8.0f}")

    print(f"\n{'='*100}")
    print(f"  TOP 15 COMBINATIONS BY TOTAL PROFIT")
    print(f"{'='*100}")
    print(f"  {'#':>3s}  {'Filter':<12s} {'Combo':<16s} {'Days':>5s} {'ROI':>8s} {'$/day':>8s} {'P/L':>8s}")
    print(f"  {'-'*3}  {'-'*10}  {'-'*14}  {'-'*5} {'-'*8} {'-'*8} {'-'*8}")
    for i, r in enumerate(sorted(all_results, key=lambda x: x[5], reverse=True)[:15], 1):
        label, combo_label, days, roi, dpd, pl, _, _ = r
        print(f"  {i:3d}  {label:<12s} {combo_label:<16s} {days:5d} {roi:+7.1f}% {dpd:+7.2f} {pl:+8.0f}")

    print("="*100)


if __name__ == '__main__':
    main()
