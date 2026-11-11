"""
Parlay Overlap Strategy Backtest
=================================
Compares multiple strategies for how picks are shared across tiers:
  A) FULL OVERLAP:     Each tier picks independently (current behavior)
  B) LOCKS OVERLAP:    Only LOCK-tier picks can appear in multiple parlays
  C) TOP-1 OVERLAP:    Only the single best pick can overlap across tiers
  D) TOP-2 OVERLAP:    Top 2 picks can overlap, rest are exclusive
  E) FULL EXCLUSIVE:   No pick can appear in more than one parlay

Tests the standard portfolio: 1x 2-leg + 1x 4-leg + 1x 5-leg ($5 each)
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
MAX_FAVORITE_ODDS = -150  # DFS platforms don't offer lines heavier than -150

def pick_parlay(pool, used_keys, n_legs, min_mins_fn=None, date=None):
    """Pick n legs from pool, avoiding used_keys. Returns (legs, new_keys) or None."""
    selected = []
    used_players = set()
    for p in pool:
        if len(selected) >= n_legs: break
        key = f"{p['player_name']}|{p['stat_type']}"
        if key in used_keys: continue
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
    new_keys = {f"{l['player_name']}|{l['stat_type']}" for l in selected}
    return selected, new_keys


def evaluate_parlay(legs, hist_map):
    decimal = 1.0
    for l in legs:
        odds = hist_map.get(f"{l['player_name']}|{l['stat_type']}|{l['game_date']}")
        decimal *= to_decimal(odds)
    hit = all(l['hit'] is True for l in legs)
    return decimal, hit


def get_overlap_keys(mode, pool, global_used, tier_idx):
    """
    Determine which keys to block for this tier based on the overlap strategy.
    Returns the set of keys to exclude.
    """
    if mode == 'full_overlap':
        # No exclusions — every tier picks independently
        return set()

    elif mode == 'locks_overlap':
        # Only LOCK picks are allowed to overlap; exclude non-LOCK used keys
        non_lock_used = set()
        for key in global_used:
            # Check if this key was from a LOCK pick
            if key not in global_used.get('_lock_keys', set()):
                non_lock_used.add(key)
        # Simpler: global_used stores all, but we only block non-locks
        return global_used.get('_non_lock', set())

    elif mode == 'top1_overlap':
        # The #1 pick (highest confidence) can appear everywhere
        # Exclude everything in global_used EXCEPT the top-1 key
        top1 = global_used.get('_top1', set())
        return global_used.get('_all', set()) - top1

    elif mode == 'top2_overlap':
        # Top 2 picks can appear everywhere
        topN = global_used.get('_topN', set())
        return global_used.get('_all', set()) - topN

    elif mode == 'full_exclusive':
        return global_used.get('_all', set())

    return set()


def run_strategy(mode, pool, date, get_avg_mins, hist_map, top_keys=None):
    """
    Run a single strategy for one date.
    Returns list of (decimal, hit, tier_idx) or None if can't fill all 3 tiers.

    For hybrid modes, we track which keys are used and which are allowed to overlap.
    """
    # Track state differently per mode
    all_used = set()         # all keys used across tiers
    lock_keys_used = set()   # keys that came from LOCK picks
    parlays_today = []

    for tier_idx, (n_legs, use_min_mins) in enumerate([(2, False), (4, True), (5, True)]):
        # Determine exclusion set based on mode
        if mode == 'full_overlap':
            excluded = set()
        elif mode == 'full_exclusive':
            excluded = set(all_used)
        elif mode == 'locks_overlap':
            # Block only non-LOCK used keys (LOCKs can repeat)
            excluded = all_used - lock_keys_used
        elif mode == 'top1_overlap':
            # Block everything except the single top key
            excluded = all_used - (top_keys if top_keys else set())
        elif mode == 'top2_overlap':
            # Block everything except top 2 keys
            excluded = all_used - (top_keys if top_keys else set())
        else:
            excluded = set()

        min_fn = get_avg_mins if use_min_mins else None
        result = pick_parlay(pool, excluded, n_legs, min_fn, date)
        if result is None:
            return None

        legs, new_keys = result
        decimal, hit = evaluate_parlay(legs, hist_map)
        parlays_today.append((decimal, hit, tier_idx))

        # Track used keys
        all_used.update(new_keys)
        if mode == 'locks_overlap':
            for leg in legs:
                if leg['confidence_label'] == 'LOCK':
                    lock_keys_used.add(f"{leg['player_name']}|{leg['stat_type']}")

    if len(parlays_today) < 3:
        return None
    return parlays_today


def main():
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

    # Odds
    print("Loading prop_history for odds...")
    hist_map = {}
    hist_raw = supabase_get_all('prop_history', 'select=game_date,player_name,stat_type,direction,odds&direction=eq.over')
    for r in hist_raw:
        key = f"{r['player_name']}|{r['stat_type']}|{r['game_date']}"
        if key not in hist_map: hist_map[key] = r['odds']
    print(f"  {len(hist_map)} odds entries loaded")

    # Avg minutes
    print("Loading player_game_logs for avg minutes...")
    logs_by_player = defaultdict(list)
    logs_raw = supabase_get_all('player_game_logs', 'select=player_name,game_date,minutes&minutes=not.is.null&order=game_date.asc')
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

    # ── Strategies to test ────────────────────────────────────────────────────
    modes = [
        'full_overlap',     # Current behavior
        'locks_overlap',    # Only LOCKs can repeat across parlays
        'top1_overlap',     # Only the #1 pick can repeat
        'top2_overlap',     # Top 2 picks can repeat
        'full_exclusive',   # No repeats at all
    ]

    mode_labels = {
        'full_overlap':    'FULL OVERLAP (current)',
        'locks_overlap':   'LOCKS ONLY OVERLAP',
        'top1_overlap':    'TOP-1 PICK OVERLAPS',
        'top2_overlap':    'TOP-2 PICKS OVERLAP',
        'full_exclusive':  'FULLY EXCLUSIVE',
    }

    results = {}
    for m in modes:
        results[m] = {'spent': 0, 'won': 0, 'days': 0, 'hits': [0,0,0], 'total': [0,0,0]}

    for date in dates:
        # Filter out heavy favorites (odds < -150) — not available on DFS platforms
        all_props = by_date[date]
        filtered = []
        for p in all_props:
            odds_key = f"{p['player_name']}|{p['stat_type']}|{p['game_date']}"
            odds = hist_map.get(odds_key)
            if odds is not None and odds < MAX_FAVORITE_ODDS:
                continue  # skip heavy favorites
            filtered.append(p)
        pool = sorted(filtered, key=lambda p: p['confidence_score'], reverse=True)

        # Precompute top-1 and top-2 keys for hybrid modes
        # These are the highest confidence picks that pass all filters
        top_picks = []
        seen_players = set()
        for p in pool:
            if p['hit'] is None: continue
            if p['stat_type'] not in MARKETS: continue
            if p['stat_type'] in VOLATILE and p['confidence_label'] != 'LOCK': continue
            if p['confidence_label'] not in ('LOCK', 'PLAY'): continue
            if p['player_name'] in seen_players: continue
            top_picks.append(p)
            seen_players.add(p['player_name'])
            if len(top_picks) >= 2: break

        top1_keys = {f"{top_picks[0]['player_name']}|{top_picks[0]['stat_type']}"} if len(top_picks) >= 1 else set()
        top2_keys = {f"{p['player_name']}|{p['stat_type']}" for p in top_picks[:2]} if len(top_picks) >= 2 else top1_keys

        for mode in modes:
            if mode == 'top1_overlap':
                tk = top1_keys
            elif mode == 'top2_overlap':
                tk = top2_keys
            else:
                tk = None

            parlays = run_strategy(mode, pool, date, get_avg_mins, hist_map, top_keys=tk)
            if parlays is None: continue

            r = results[mode]
            r['days'] += 1
            for decimal, hit, tier_idx in parlays:
                r['spent'] += STAKE
                r['total'][tier_idx] += 1
                if hit:
                    r['won'] += STAKE * decimal
                    r['hits'][tier_idx] += 1

    # ── Report ────────────────────────────────────────────────────────────────
    print("\n" + "="*80)
    print(f"{'PARLAY OVERLAP STRATEGY COMPARISON':^80}")
    print(f"{'(1x 2-leg + 1x 4-leg + 1x 5-leg, $5 each = $15/day)':^80}")
    print("="*80)

    tier_labels = ['2-leg Safe', '4-leg Premium', '5-leg Jackpot']

    # Collect for summary table
    summary_rows = []

    for mode in modes:
        r = results[mode]
        roi = ((r['won'] - r['spent']) / r['spent'] * 100) if r['spent'] > 0 else 0
        daily_profit = (r['won'] - r['spent']) / r['days'] if r['days'] > 0 else 0
        total_pl = r['won'] - r['spent']
        label = mode_labels[mode]

        print(f"\n-- {label} " + "-" * max(1, 76 - len(label)))
        print(f"  Days tested:    {r['days']}")
        print(f"  Total spent:    ${r['spent']:.0f}")
        print(f"  Total won:      ${r['won']:.0f}")
        print(f"  Total P/L:      ${total_pl:+.0f}")
        print(f"  ROI:            {roi:+.1f}%")
        print(f"  Daily profit:   ${daily_profit:+.2f}/day")
        print()
        for i, tl in enumerate(tier_labels):
            rate = r['hits'][i]/r['total'][i]*100 if r['total'][i] > 0 else 0
            print(f"  {tl:22s}  {r['hits'][i]:3d}/{r['total'][i]:3d}  ({rate:.1f}% hit rate)")

        summary_rows.append((label, r['days'], roi, daily_profit, total_pl,
                             r['hits'][0], r['total'][0], r['hits'][1], r['total'][1], r['hits'][2], r['total'][2]))

    # ── Summary Table ─────────────────────────────────────────────────────────
    print(f"\n{'='*80}")
    print(f"{'SUMMARY TABLE':^80}")
    print("="*80)
    print(f"  {'Strategy':<28s} {'Days':>5s} {'ROI':>8s} {'$/day':>8s} {'P/L':>8s}  {'2L':>7s} {'4L':>7s} {'5L':>7s}")
    print(f"  {'-'*26}  {'-'*5} {'-'*8} {'-'*8} {'-'*8}  {'-'*7} {'-'*7} {'-'*7}")
    for row in summary_rows:
        label, days, roi, dpd, pl, h2, t2, h4, t4, h5, t5 = row
        r2 = h2/t2*100 if t2 else 0
        r4 = h4/t4*100 if t4 else 0
        r5 = h5/t5*100 if t5 else 0
        print(f"  {label:<28s} {days:5d} {roi:+7.1f}% {dpd:+7.2f} {pl:+8.0f}  {r2:5.1f}% {r4:5.1f}% {r5:5.1f}%")

    # Winner
    best = max(summary_rows, key=lambda x: x[2])
    print(f"\n  >>> BEST STRATEGY: {best[0]} ({best[2]:+.1f}% ROI, ${best[3]:+.2f}/day)")
    print("="*80)


if __name__ == '__main__':
    main()
