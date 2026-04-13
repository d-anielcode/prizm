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


def optimize_weights(cases, stat, n_iter=10000):
    """Dirichlet random search for optimal weight vector for one stat type."""
    stat_cases = [c for c in cases if c['stat'] == stat]
    if len(stat_cases) < 30:
        return None, 0.0

    X = np.array([[c['features'][f] for f in FACTOR_NAMES] for c in stat_cases])
    y = np.array([c['label'] for c in stat_cases])

    best_score, best_w = -1.0, None
    for _ in range(n_iter):
        w = np.random.dirichlet(np.ones(11))
        scores = X @ w
        lock_mask = scores >= 0.68
        play_mask = (scores >= 0.60) & (scores < 0.68)

        lock_n = lock_mask.sum()
        play_n = play_mask.sum()
        lock_hr = y[lock_mask].mean() if lock_n >= 3 else 0.0
        play_hr = y[play_mask].mean() if play_n >= 5 else 0.0

        combined = 0.6 * lock_hr + 0.4 * play_hr
        if combined > best_score:
            best_score = combined
            best_w = w

    if best_w is None:
        return None, 0.0

    weights = {name: round(float(best_w[i]), 3) for i, name in enumerate(FACTOR_NAMES)}
    total = sum(weights.values())
    if total > 0:
        weights = {k: round(v / total, 3) for k, v in weights.items()}
        diff = round(1.0 - sum(weights.values()), 3)
        weights['last20HitRate'] = round(weights['last20HitRate'] + diff, 3)

    return weights, best_score


def calibrate_thresholds(cases, stat, weights_dict):
    """Scan LOCK/PLAY thresholds for optimal accuracy."""
    stat_cases = [c for c in cases if c['stat'] == stat]
    if len(stat_cases) < 30:
        return 74, 68

    X = np.array([[c['features'][f] for f in FACTOR_NAMES] for c in stat_cases])
    y = np.array([c['label'] for c in stat_cases])
    w = np.array([weights_dict.get(f, 0.0) for f in FACTOR_NAMES])
    raw_scores = X @ w * 100

    best_combo, best_metric = (74, 68), -1.0
    for lock_t in range(70, 83, 2):
        for play_t in [lock_t - 4, lock_t - 6, lock_t - 8]:
            if play_t < 58: continue
            lock_mask = raw_scores >= lock_t
            play_mask = (raw_scores >= play_t) & (raw_scores < lock_t)
            lock_n = lock_mask.sum()
            if lock_n < 3: continue
            lock_hr = y[lock_mask].mean()
            play_hr = y[play_mask].mean() if play_mask.sum() >= 5 else 0.0
            metric = 0.6 * lock_hr + 0.4 * play_hr
            if metric > best_metric:
                best_metric = metric
                best_combo = (lock_t, play_t)

    return best_combo


def recalibrate_over_bias(grades):
    """Compute stat-specific over bias from over/under hit rate gap."""
    bias = {}
    for stat in STAT_TYPES:
        overs = [g for g in grades if g['stat_type'] == stat and g.get('direction') == 'over' and g.get('hit') is not None]
        unders = [g for g in grades if g['stat_type'] == stat and g.get('direction') == 'under' and g.get('hit') is not None]
        if len(overs) < 20 or len(unders) < 10:
            bias[stat] = -3
            continue
        o_hr = sum(1 for g in overs if g['hit']) / len(overs)
        u_hr = sum(1 for g in unders if g['hit']) / len(unders)
        gap = u_hr - o_hr
        raw_bias = round(gap * 30)
        bias[stat] = max(-10, min(0, -abs(raw_bias)))
    return bias


def check_rollback(config, recent_grades, logs_by_player, def_stats_map):
    """
    Pre-flight: if last week's retrained weights degraded LOCK accuracy by >5pp,
    roll back to previous_weights.
    Returns True if rollback was performed.
    """
    if not config or not config.get('previous_weights'):
        return False

    last_retrained = config.get('last_retrained', '')
    try:
        retrained_dt = datetime.fromisoformat(last_retrained.replace('Z', '+00:00'))
        age_days = (datetime.now(timezone.utc) - retrained_dt).days
        if age_days < 7:
            print("  Rollback check: weights are < 7 days old, skipping.")
            return False
    except (ValueError, TypeError):
        return False

    baseline_lock = config.get('validation_accuracy', {}).get('lock', 0.0)
    cases = build_cases(recent_grades, logs_by_player, def_stats_map)
    if len(cases) < 50:
        print(f"  Rollback check: only {len(cases)} recent cases, skipping.")
        return False

    cur_lock_hr, _, cur_lock_n, _ = score_cases(
        cases, config['weights'],
        config.get('lock_thresholds', {}),
        config.get('play_thresholds', {}),
        config.get('base_lock_threshold', 74),
        config.get('base_play_threshold', 68),
    )

    drop = baseline_lock - cur_lock_hr
    print(f"  Rollback check: baseline LOCK={baseline_lock:.1%}, actual={cur_lock_hr:.1%} (n={cur_lock_n}), drop={drop:+.1%}")

    if drop > 0.05 and cur_lock_n >= 10:
        print(f"  ROLLBACK: LOCK accuracy dropped {drop:.1%} (>5pp threshold)")
        prev = config['previous_weights']
        config['weights'] = prev['weights']
        config['lock_thresholds'] = prev.get('lock_thresholds', {})
        config['play_thresholds'] = prev.get('play_thresholds', {})
        config['over_bias'] = prev.get('over_bias', {})
        config['previous_weights'] = None
        config['version'] = config.get('previous_version', config['version']) + '-rollback'
        config['last_retrained'] = datetime.now(timezone.utc).isoformat()
        with open(JSON_PATH, 'w') as f:
            json.dump(config, f, indent=2)
        print(f"  Rolled back to {config['version']}. Skipping retraining this week.")
        return True

    return False


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

    # -- Pre-flight rollback check ---------------------------------------------
    current_config_precheck = None
    try:
        with open(JSON_PATH) as f:
            current_config_precheck = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        pass

    if current_config_precheck:
        recent_week = (datetime.now(timezone.utc) - timedelta(days=7)).strftime('%Y-%m-%d')
        recent_grades = [g for g in grades if g['game_date'] >= recent_week]
        if check_rollback(current_config_precheck, recent_grades, logs_by_player, def_stats_map):
            sys.exit(0)

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

    # -- Optimize weights per stat ---------------------------------------------
    print("\n[3/5] Optimizing weights per stat type...")
    new_weights = {}
    new_lock_thresholds = {}
    new_play_thresholds = {}

    for stat in STAT_TYPES:
        stat_train = [c for c in train_cases if c['stat'] == stat]
        if len(stat_train) < 30:
            print(f"  {stat}: skipped ({len(stat_train)} cases, need 30)")
            continue

        w, score = optimize_weights(train_cases, stat, n_iter=args.iterations)
        if w is None:
            print(f"  {stat}: optimization failed")
            continue

        lock_t, play_t = calibrate_thresholds(train_cases, stat, w)
        new_weights[stat] = w
        new_lock_thresholds[stat] = lock_t
        new_play_thresholds[stat] = play_t
        print(f"  {stat}: score={score:.3f} lock_t={lock_t} play_t={play_t}")

    if not new_weights:
        print("  No stats optimized successfully. Exiting.")
        sys.exit(0)

    # -- Calibrate base thresholds + over-bias ---------------------------------
    print("\n[4/5] Calibrating base thresholds and over-bias...")
    best_base_lock, best_base_metric = 74, -1.0
    X_all = np.array([[c['features'][f] for f in FACTOR_NAMES] for c in train_cases])
    y_all = np.array([c['label'] for c in train_cases])
    w_avg = np.ones(11) / 11
    scores_all = X_all @ w_avg * 100
    for base_t in range(70, 79, 2):
        lock_mask = scores_all >= base_t
        if lock_mask.sum() < 10: continue
        hr = y_all[lock_mask].mean()
        if hr > best_base_metric:
            best_base_metric = hr
            best_base_lock = base_t
    base_lock = best_base_lock
    base_play = base_lock - 6

    new_over_bias = recalibrate_over_bias(grades)
    print(f"  Base thresholds: LOCK={base_lock} PLAY={base_play}")
    print(f"  Over bias: {new_over_bias}")

    # -- Validation ------------------------------------------------------------
    print("\n[5/5] Validating against held-out set...")

    new_lock_hr, new_play_hr, new_lock_n, new_play_n = score_cases(
        val_cases, new_weights, new_lock_thresholds, new_play_thresholds, base_lock, base_play
    )
    print(f"  New weights:     LOCK {new_lock_hr:.1%} (n={new_lock_n}) | PLAY {new_play_hr:.1%} (n={new_play_n})")

    current_config = None
    try:
        with open(JSON_PATH) as f:
            current_config = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        pass

    cur_lock_hr, cur_play_hr = 0.0, 0.0
    if current_config and current_config.get('weights'):
        cur_lock_hr, cur_play_hr, cur_lock_n, cur_play_n = score_cases(
            val_cases, current_config['weights'],
            current_config.get('lock_thresholds', {}),
            current_config.get('play_thresholds', {}),
            current_config.get('base_lock_threshold', 74),
            current_config.get('base_play_threshold', 68),
        )
        print(f"  Current weights: LOCK {cur_lock_hr:.1%} (n={cur_lock_n}) | PLAY {cur_play_hr:.1%} (n={cur_play_n})")

    # -- Adoption decision -----------------------------------------------------
    new_combined = 0.6 * new_lock_hr + 0.4 * new_play_hr
    cur_combined = 0.6 * cur_lock_hr + 0.4 * cur_play_hr
    improvement = new_combined - cur_combined

    adopt = (
        new_lock_hr >= cur_lock_hr and
        improvement >= 0.005 and
        new_lock_n >= 20
    )

    if not adopt:
        reasons = []
        if new_lock_hr < cur_lock_hr: reasons.append(f"LOCK regressed ({new_lock_hr:.1%} < {cur_lock_hr:.1%})")
        if improvement < 0.005: reasons.append(f"improvement too small ({improvement:+.1%})")
        if new_lock_n < 20: reasons.append(f"too few LOCKs ({new_lock_n})")
        print(f"\n  REJECTED: {', '.join(reasons)}")
        print("  Keeping current weights.")
        sys.exit(0)

    print(f"\n  ADOPTED: improvement {improvement:+.1%} (combined {cur_combined:.1%} -> {new_combined:.1%})")

    if args.dry_run:
        print("  --dry-run: not writing JSON.")
        sys.exit(0)

    # -- Write JSON ------------------------------------------------------------
    version = "v11.1"
    if current_config:
        cur_v = current_config.get('version', 'v11.0')
        try:
            parts = cur_v.replace('v', '').split('.')
            minor = int(parts[-1]) + 1
            version = f"v{parts[0]}.{minor}"
        except (ValueError, IndexError):
            version = "v11.1"

    dates = sorted(set(g['game_date'] for g in grades))
    output = {
        'version': version,
        'last_retrained': datetime.now(timezone.utc).isoformat(),
        'data_window': {
            'start': dates[0] if dates else cutoff,
            'end': dates[-1] if dates else cutoff,
            'game_days': len(dates),
            'graded_props': len(grades),
        },
        'validation_accuracy': {
            'lock': round(float(new_lock_hr), 4),
            'play': round(float(new_play_hr), 4),
            'overall': round(float(new_combined), 4),
        },
        'previous_version': current_config.get('version') if current_config else None,
        'weights': new_weights,
        'lock_thresholds': new_lock_thresholds,
        'play_thresholds': new_play_thresholds,
        'base_lock_threshold': base_lock,
        'base_play_threshold': base_play,
        'over_bias': new_over_bias,
        'previous_weights': {
            'weights': current_config['weights'],
            'lock_thresholds': current_config.get('lock_thresholds', {}),
            'play_thresholds': current_config.get('play_thresholds', {}),
            'over_bias': current_config.get('over_bias', {}),
            'validation_accuracy': current_config.get('validation_accuracy', {}),
        } if current_config else None,
    }

    with open(JSON_PATH, 'w') as f:
        json.dump(output, f, indent=2)
    print(f"\n  Written to {JSON_PATH} ({version})")
