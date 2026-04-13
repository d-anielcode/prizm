"""
Prizm Auto-Retrain -- Self-Improving Confidence Engine
=====================================================
Weekly retraining script that:
1. Loads 60-day rolling window of prop_grades + game logs
2. Optimizes per-stat weights via Dirichlet random search
3. Calibrates thresholds and over-bias from fresh data
4. Validates new weights against held-out set
5. Writes lib/confidence-weights.json if improved

Usage:
    python scripts/auto_retrain.py
    python scripts/auto_retrain.py --days 90
    python scripts/auto_retrain.py --dry-run
"""

import os, sys, json, re, argparse
from datetime import datetime, timedelta, timezone
from collections import defaultdict

# -- Load .env.local ----------------------------------------------------------
env = {}
ENV_PATH = os.path.join(os.path.dirname(__file__), '..', '.env.local')
try:
    with open(ENV_PATH) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                v = v.strip().strip('"').strip("'")
                env[k.strip()] = v
except FileNotFoundError:
    pass

import requests
import numpy as np

SUPABASE_URL = (os.environ.get('NEXT_PUBLIC_SUPABASE_URL') or env.get('NEXT_PUBLIC_SUPABASE_URL', '')).strip('"').strip("'")
SUPABASE_KEY = (os.environ.get('SUPABASE_SERVICE_KEY') or env.get('SUPABASE_SERVICE_KEY', '')).strip('"').strip("'")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("ERROR: Missing SUPABASE env vars in .env.local")
    sys.exit(1)

SB_HEADERS = {
    'apikey': SUPABASE_KEY,
    'Authorization': f'Bearer {SUPABASE_KEY}',
}

def sb_get_all(table, params=''):
    rows, offset = [], 0
    while True:
        sep = '&' if params else ''
        url = f'{SUPABASE_URL}/rest/v1/{table}?{params}{sep}limit=1000&offset={offset}'
        r = requests.get(url, headers=SB_HEADERS, timeout=30)
        r.raise_for_status()
        batch = r.json()
        if not batch: break
        rows.extend(batch)
        if len(batch) < 1000: break
        offset += 1000
    return rows


STAT_TYPES = ['points', 'rebounds', 'assists', 'steals', 'blocks', 'three_pointers', 'pra']
FACTOR_NAMES = ['lineValue', 'matchupEdge', 'last20HitRate', 'trend', 'seasonCushion',
                'pace', 'newsInjury', 'restDays', 'blowout', 'homeAway', 'vsOpponent']
JSON_PATH = os.path.join(os.path.dirname(__file__), '..', 'lib', 'confidence-weights.json')


# -- Factor computation (same as backtest.py / model_diagnostic.py) -----------
def get_stat(log, stat_type):
    return {
        'points': float(log.get('points', 0) or 0),
        'rebounds': float(log.get('rebounds', 0) or 0),
        'assists': float(log.get('assists', 0) or 0),
        'steals': float(log.get('steals', 0) or 0),
        'blocks': float(log.get('blocks', 0) or 0),
        'three_pointers': float(log.get('fg3m', 0) or 0),
        'pra': float(log.get('pra', 0) or 0),
    }.get(stat_type, 0.0)

def extract_opponent(matchup):
    parts = re.split(r'\s+vs\.\s+|\s+@\s+', matchup)
    return parts[1].strip().upper() if len(parts) >= 2 else None

def clamp(x, lo=0.05, hi=0.95):
    return min(hi, max(lo, x))

def factor_last_n_hitrate(prior, stat_type, line, direction, n):
    sl = prior[:n]
    if len(sl) < 3: return None
    hits = sum(1 for g in sl if (get_stat(g, stat_type) > line if direction == 'over' else get_stat(g, stat_type) < line))
    return hits / len(sl)

def factor_cushion(prior, stat_type, line, direction):
    vals = [get_stat(g, stat_type) for g in prior if get_stat(g, stat_type) >= 0]
    if len(vals) < 5: return 0.5
    avg = sum(vals) / len(vals)
    pct = (avg - line) / max(line, 1)
    raw = clamp(pct / 0.60 + 0.50)
    return raw if direction == 'over' else 1 - raw

def factor_trend(prior, stat_type, direction):
    l5 = [get_stat(g, stat_type) for g in prior[:5]]
    l20 = [get_stat(g, stat_type) for g in prior[:20]]
    if len(l5) < 3 or len(l20) < 8: return 0.5
    avg5, avg20 = sum(l5)/len(l5), sum(l20)/len(l20)
    if avg20 == 0: return 0.5
    raw = clamp((avg5 - avg20) / avg20 / 0.40 + 0.50)
    return raw if direction == 'over' else 1 - raw

def factor_matchup(def_stats_map, opp_abbr, stat_type, direction):
    if not opp_abbr or opp_abbr not in def_stats_map: return 0.5
    rank_key = {'points':'pts_rank','rebounds':'reb_rank','assists':'ast_rank',
                'steals':'stl_rank','blocks':'blk_rank','three_pointers':'fg3m_rank','pra':'pts_rank'}.get(stat_type,'pts_rank')
    rank = def_stats_map[opp_abbr].get(rank_key, 15)
    raw = (rank - 1) / 29
    return raw if direction == 'over' else 1 - raw

def factor_vs_opponent(prior, stat_type, line, direction, opp_abbr):
    if not opp_abbr: return 0.5
    vs = [g for g in prior if extract_opponent(g.get('matchup','')) == opp_abbr]
    if len(vs) < 2: return 0.5
    hits = sum(1 for g in vs if (get_stat(g, stat_type) > line if direction == 'over' else get_stat(g, stat_type) < line))
    w = min(0.80, 0.15 + len(vs) * 0.13)
    return (hits/len(vs)) * w + 0.5 * (1 - w)

def factor_home_away(prior, stat_type, line, direction, is_home):
    filtered = [g for g in prior if g.get('is_home') == is_home]
    if len(filtered) < 5: return 0.5
    hits = sum(1 for g in filtered if (get_stat(g, stat_type) > line if direction == 'over' else get_stat(g, stat_type) < line))
    return hits / len(filtered)

def factor_rest_days(prior_logs, game_date):
    if not prior_logs: return 0.5
    try:
        last = datetime.strptime(prior_logs[0]['game_date'], '%Y-%m-%d')
        curr = datetime.strptime(game_date, '%Y-%m-%d')
        rest = (curr - last).days - 1
        if rest <= 0: return 0.25
        if rest == 1: return 0.50
        if rest == 2: return 0.60
        return 0.55
    except Exception:
        return 0.5


def build_cases(grades, logs_by_player, def_stats_map):
    """Build feature vectors for graded props."""
    cases = []
    for g in grades:
        player, stat = g['player_name'], g['stat_type']
        line, direction = float(g['line']), g.get('direction', 'over')
        game_date = g['game_date']
        hit = 1 if g['hit'] else 0

        if player not in logs_by_player: continue
        all_logs = sorted(logs_by_player[player], key=lambda l: l['game_date'])
        prior = list(reversed([l for l in all_logs if l['game_date'] < game_date]))
        if len(prior) < 10: continue

        target = next((l for l in all_logs if l['game_date'] == game_date), None)
        if not target: continue
        opp = extract_opponent(target.get('matchup', ''))
        is_home = target.get('is_home', False)

        features = {
            'lineValue':     factor_last_n_hitrate(prior, stat, line, direction, 10) or 0.5,
            'matchupEdge':   factor_matchup(def_stats_map, opp, stat, direction),
            'last20HitRate': factor_last_n_hitrate(prior, stat, line, direction, 20) or 0.5,
            'trend':         factor_trend(prior, stat, direction),
            'seasonCushion': factor_cushion(prior, stat, line, direction),
            'pace':          0.5,
            'newsInjury':    0.5,
            'restDays':      factor_rest_days(prior, game_date),
            'blowout':       0.5,
            'homeAway':      factor_home_away(prior, stat, line, direction, is_home),
            'vsOpponent':    factor_vs_opponent(prior, stat, line, direction, opp),
        }
        cases.append({'features': features, 'label': hit, 'stat': stat, 'direction': direction})
    return cases


def score_cases(cases, weights_map, lock_thresholds, play_thresholds, b_lock, b_play):
    """Score cases with given weights and compute LOCK/PLAY accuracy."""
    locks, plays = [], []
    for c in cases:
        stat = c['stat']
        w_dict = weights_map.get(stat)
        if not w_dict: continue
        w = np.array([w_dict.get(f, 0.0) for f in FACTOR_NAMES])
        feat = np.array([c['features'][f] for f in FACTOR_NAMES])
        score = float(feat @ w) * 100
        lt = lock_thresholds.get(stat, b_lock)
        pt = play_thresholds.get(stat, b_play)
        if score >= lt:
            locks.append(c['label'])
        elif score >= pt:
            plays.append(c['label'])
    lock_hr = sum(locks) / len(locks) if locks else 0.0
    play_hr = sum(plays) / len(plays) if plays else 0.0
    return lock_hr, play_hr, len(locks), len(plays)


def parse_args():
    p = argparse.ArgumentParser(description='Prizm Auto-Retrain')
    p.add_argument('--days', type=int, default=60, help='Rolling window in days (default: 60)')
    p.add_argument('--dry-run', action='store_true', help='Validate but do not write JSON')
    p.add_argument('--iterations', type=int, default=10000, help='Dirichlet samples per stat (default: 10000)')
    return p.parse_args()


if __name__ == '__main__':
    args = parse_args()
    print("Prizm Auto-Retrain")
    print("=" * 60)
    print(f"  Window: {args.days} days | Iterations: {args.iterations} | Dry run: {args.dry_run}")

    # -- Load data -------------------------------------------------------------
    cutoff = (datetime.now(timezone.utc) - timedelta(days=args.days)).strftime('%Y-%m-%d')
    print(f"\n[1/5] Loading prop_grades since {cutoff}...")
    grades = sb_get_all('prop_grades', f'game_date=gte.{cutoff}&order=game_date.asc')
    grades = [g for g in grades if g.get('hit') is not None]
    if len(grades) < 200:
        print(f"  Only {len(grades)} grades -- need 200+. Exiting.")
        sys.exit(0)
    print(f"  {len(grades):,} graded props loaded")

    print("  Loading game logs...")
    raw_logs = sb_get_all('player_game_logs', 'order=game_date.desc')
    logs_by_player = defaultdict(list)
    for log in raw_logs:
        if log.get('player_name') and log.get('game_date'):
            logs_by_player[log['player_name']].append(log)
    print(f"  {len(raw_logs):,} game logs for {len(logs_by_player)} players")

    print("  Loading defense stats...")
    def_rows = sb_get_all('team_defense_stats')
    def_stats_map = {r['team_abbreviation']: r for r in def_rows}

    # -- Build cases -----------------------------------------------------------
    print("\n[2/5] Building feature vectors...")
    all_cases = build_cases(grades, logs_by_player, def_stats_map)
    print(f"  {len(all_cases):,} matched cases")

    if len(all_cases) < 100:
        print("  Not enough matched cases. Exiting.")
        sys.exit(0)

    # -- Train/validation split (chronological 75/25) --------------------------
    split_idx = int(len(all_cases) * 0.75)
    train_cases = all_cases[:split_idx]
    val_cases = all_cases[split_idx:]
    print(f"  Train: {len(train_cases):,} | Validation: {len(val_cases):,}")

    # Placeholders for Tasks 4-5
    print("\n[3/5] Weight optimization... (not yet implemented)")
    print("\n[4/5] Threshold calibration... (not yet implemented)")
    print("\n[5/5] Validation... (not yet implemented)")
    print("\nDone (skeleton only).")
