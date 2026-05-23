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


# ── Score-time additives — Python mirror of lib/confidence.ts:computeAdditives ──
#
# Before 2026-05-20, this script optimized factor weights against feat @ w * 100,
# omitting the 14 additives that production scoreProps actually applies. Auto-
# retrain was therefore tuning weights to compensate for absent signal — a
# divergent phantom model. This block restores parity for everything we can
# compute in Python without extra DB tables.
#
# Implemented in Python: consensusAdj, starBonus, freshness (multiplier),
# minutesTrendAdj, minutesUncertaintyPenalty, consistencyAdj, opponentB2bAdj,
# biasAdj (player_line_bias), leakAdj (opponent_stat_leaks), overBiasAdj,
# underBiasAdj.
#
# NOT implemented here (would need extra loads / point-in-time data):
#   lineMovAdj, oddsMovAdj  — need prop_history snapshots
#   simAdj                  — needs sim_3pm rows
#   lineupAdj               — most historical props pre-date confirmed_lineups
# These default to 0 — acceptable since they primarily affect *today's* picks
# and the optimizer trains on historical data where they were also ~zero.

# Hardcoded fallbacks ONLY — _load_bias_defaults reads the live JSON first.
# Audit M1d 2026-05-23: the previous setup hardcoded these in Python which
# silently drifted from confidence-weights.json whenever the JSON was hand-
# edited (e.g. the v11.1 manual retune). Now we read JSON first, fall back to
# these constants only if the file is missing/malformed.
_OVER_BIAS_FALLBACK = {'points': -3, 'rebounds': -4, 'assists': -4, 'pra': -4,
                       'steals': -10, 'blocks': -8, 'three_pointers': -7}
_UNDER_BIAS_FALLBACK = {'blocks': 8, 'steals': 6, 'assists': 4, 'pra': 3,
                        'rebounds': 3, 'points': 2, 'three_pointers': 2}

def _load_bias_defaults():
    """Read confidence-weights.json once, return (over_bias, under_bias) maps.
    Falls back to hardcoded values if file missing/malformed."""
    try:
        with open(JSON_PATH) as f:
            cfg = json.load(f)
        ob = {**_OVER_BIAS_FALLBACK,  **(cfg.get('over_bias')  or {})}
        ub = {**_UNDER_BIAS_FALLBACK, **(cfg.get('under_bias') or {})}
        return ob, ub
    except (FileNotFoundError, json.JSONDecodeError, KeyError):
        return dict(_OVER_BIAS_FALLBACK), dict(_UNDER_BIAS_FALLBACK)

# Loaded once at module level — same lifetime as the rest of the script's
# module-level constants. If the JSON changes mid-run we don't see it, which
# is fine: a fresh process run picks it up.
OVER_BIAS_DEFAULTS, UNDER_BIAS_DEFAULTS = _load_bias_defaults()

def consistency_cv(prior, stat_type):
    """CV on L10 stat outcomes — mirrors lib/confidence.ts:consistencyCV."""
    recent = [l for l in prior if (l.get('minutes') or 0) >= 5][:10]
    if len(recent) < 5: return None
    vals = [get_stat(l, stat_type) for l in recent]
    mean = sum(vals) / len(vals)
    if mean < 1: return None
    var = sum((v - mean) ** 2 for v in vals) / len(vals)
    return (var ** 0.5) / mean

def consistency_adj_for(cv, stat_type):
    if cv is None: return 0
    is_volatile = stat_type in ('blocks', 'steals')
    low_cutoff  = 0.55 if is_volatile else 0.30
    high_cutoff = 0.85 if is_volatile else 0.50
    if cv <= low_cutoff:                  return 3
    if cv <= low_cutoff + 0.10:           return 1
    if cv >= high_cutoff:                 return -3
    if cv >= high_cutoff - 0.10:          return -1
    return 0

def minutes_trend_adj(prior, direction):
    eligible = [l for l in prior if (l.get('minutes') or 0) >= 5]
    l5  = eligible[:5]
    l20 = eligible[:20]
    if len(l5) < 3 or len(l20) < 8: return 0
    avg5  = sum((l.get('minutes') or 0) for l in l5)  / len(l5)
    avg20 = sum((l.get('minutes') or 0) for l in l20) / len(l20)
    if avg20 == 0: return 0
    trend = (avg5 - avg20) / avg20
    if abs(trend) < 0.10: return 0
    mag = 3 if abs(trend) >= 0.20 else 2
    return (mag if trend > 0 else -mag) * (1 if direction == 'over' else -1)

def minutes_uncertainty_penalty(prior):
    recent = [l for l in prior if (l.get('minutes') or 0) >= 1][:10]
    if len(recent) < 4: return 0
    mins = [(l.get('minutes') or 0) for l in recent]
    avg = sum(mins) / len(mins)
    var = sum((m - avg) ** 2 for m in mins) / len(mins)
    stdev = var ** 0.5
    pen = 0
    if avg < 20:    pen = -8
    elif avg < 24:  pen = -4
    if stdev > 6:   pen -= 3
    return pen

def freshness_score(prior, game_date_str):
    """Mirror of lib/confidence.ts:dataFreshness — recency-weighted compression
    on raw signal. Approximated by days-since-last-game; <=2 days = 1.0,
    decay to 0.7 over 14 days."""
    if not prior: return 1.0
    try:
        last = datetime.strptime(prior[0]['game_date'], '%Y-%m-%d')
        curr = datetime.strptime(game_date_str, '%Y-%m-%d')
        days = (curr - last).days
        if days <= 2:  return 1.0
        if days >= 14: return 0.70
        return 1.0 - (days - 2) * (0.30 / 12)
    except Exception:
        return 1.0

def consensus_adj(features):
    primary = [features['lineValue'], features['matchupEdge'],
               features['last20HitRate'], features['trend'], features['seasonCushion']]
    agree = sum(1 for f in primary if f >= 0.55)
    if agree >= 4: return 3
    if agree >= 3: return 0
    if agree >= 2: return -4
    return -10

def star_bonus(player_avg_min, direction, fLineValue, f7):
    """Mirror of scoreProps line 1358."""
    if direction != 'over': return 0
    if player_avg_min < 36: return 0
    if fLineValue < 0.58:   return 0
    if f7 < 0.55:           return 0
    return 3

def player_avg_minutes(prior, n=10):
    if not prior: return 0
    recent = prior[:n]
    return sum((l.get('minutes') or 0) for l in recent) / len(recent)

def opponent_b2b_adj(yesterday_teams, opp_abbr, direction):
    if not opp_abbr or opp_abbr not in yesterday_teams: return 0
    return 2 if direction == 'over' else -2

def bias_adj_for(bias_row, direction):
    """mult=10, cap=±5 — matches lib/confidence.ts (post-revert 4c668fe)."""
    if not bias_row: return 0
    sample = bias_row.get('sample_count', 0) or 0
    if sample < 6: return 0
    cs = min(sample / 20, 1.0)
    raw = (bias_row.get('hit_rate', 0.5) - 0.50) * cs * 10
    adj = max(-5, min(5, raw))
    return adj if direction == 'over' else -adj

def leak_adj_for(leak_row, direction):
    """mult=8, cap=±4 — REVERTED 2026-05-23 from mult=15/cap=6.

    Counterfactual showed mult=15 cost ~1pt LOCK hit rate on 84k props
    with no compensating gain (PLAY +0.5pt at best). Matches the
    player_line_bias revert lesson: amplifying long-term aggregated
    signal at high tier introduces noise. See lib/confidence.ts:leakAdj
    block for the data table."""
    if not leak_row: return 0
    sample = leak_row.get('sample_count', 0) or 0
    if sample < 10: return 0
    cs = min(sample / 40, 1.0)
    raw = (leak_row.get('over_hit_rate', 0.5) - 0.50) * cs * 8
    adj = max(-4, min(4, raw))
    return adj if direction == 'over' else -adj

def over_bias_adj(direction, stat, trailing_over_rate):
    if direction != 'over': return 0
    # Gate: fire when trailing < 0.50 OR no data (cold-start fallback)
    if trailing_over_rate is not None and trailing_over_rate >= 0.50: return 0
    return OVER_BIAS_DEFAULTS.get(stat, -3)

def under_bias_adj(direction, stat, trailing_under_rate):
    if direction != 'under': return 0
    if trailing_under_rate is not None and trailing_under_rate <= 0.50: return 0
    return UNDER_BIAS_DEFAULTS.get(stat, 2)


def build_cases(grades, logs_by_player, def_stats_map,
                player_bias_map=None, opp_leak_map=None,
                trailing_over_rates=None, trailing_under_rates=None,
                yesterday_teams_by_date=None):
    """Build feature vectors + per-prop additive total for graded props.

    Each case now carries `features` (dict, factor scores) AND `additive` (float,
    total of all score-time adjustments). score_cases_arrays consumes both.
    """
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

        # Score-time additives — mirror lib/confidence.ts:computeAdditives.
        # See module docstring for what's implemented vs deferred.
        cv = consistency_cv(prior, stat)
        freshness = freshness_score(prior, game_date)
        avg_min = player_avg_minutes(prior, 10)

        cons_adj   = consensus_adj(features)
        starB      = star_bonus(avg_min, direction, features['lineValue'], features['last20HitRate'])
        mins_trend = minutes_trend_adj(prior, direction)
        mins_unc   = minutes_uncertainty_penalty(prior)
        cons       = consistency_adj_for(cv, stat)
        bias_v     = bias_adj_for((player_bias_map or {}).get((player, stat)), direction)
        leak_v     = leak_adj_for((opp_leak_map or {}).get((opp, stat)) if opp else None, direction)
        ymap       = (yesterday_teams_by_date or {}).get(game_date, set())
        b2b_v      = opponent_b2b_adj(ymap, opp, direction)
        ob_v       = over_bias_adj(direction, stat,
                                    (trailing_over_rates or {}).get((stat, game_date)))
        ub_v       = under_bias_adj(direction, stat,
                                    (trailing_under_rates or {}).get((stat, game_date)))

        # NOTE: consensusAdj is MULTIPLIED by freshness in the score formula;
        # store it pre-multiplied to keep score_cases_arrays simple.
        additive = (
            cons_adj * freshness +
            starB +
            bias_v +
            leak_v +
            mins_trend +
            mins_unc +
            ob_v +
            ub_v +
            b2b_v +
            cons
            # lineMovAdj, oddsMovAdj, simAdj, lineupAdj: not modeled here (see docstring)
        )

        cases.append({
            'features':   features,
            'label':      hit,
            'stat':       stat,
            'direction':  direction,
            'additive':   additive,
            'freshness':  freshness,  # multiplier applied to raw - 0.5 portion
        })
    return cases


def score_cases(cases, weights_map, lock_thresholds, play_thresholds, b_lock, b_play):
    """Score cases with given weights and compute LOCK/PLAY accuracy."""
    locks, plays = score_cases_arrays(cases, weights_map, lock_thresholds, play_thresholds, b_lock, b_play)
    lock_hr = sum(locks) / len(locks) if locks else 0.0
    play_hr = sum(plays) / len(plays) if plays else 0.0
    return lock_hr, play_hr, len(locks), len(plays)


def score_cases_arrays(cases, weights_map, lock_thresholds, play_thresholds, b_lock, b_play):
    """Same scoring as score_cases but returns the raw 0/1 label arrays so
    callers can compute bootstrap CIs without re-running scoring.

    Mirrors lib/confidence.ts:scoreProps line 1389-1408:
        adjustedRaw = 0.5 + (raw - 0.5) * freshness
        score = adjustedRaw * 100 + sum_of_additives
    where `additive` already includes consensusAdj * freshness.
    """
    locks, plays = [], []
    for c in cases:
        stat = c['stat']
        w_dict = weights_map.get(stat)
        if not w_dict: continue
        w = np.array([w_dict.get(f, 0.0) for f in FACTOR_NAMES])
        feat = np.array([c['features'][f] for f in FACTOR_NAMES])
        raw = float(feat @ w)
        freshness = c.get('freshness', 1.0)
        adjusted_raw = 0.50 + (raw - 0.50) * freshness
        # Clamp to [18, 95] like scoreProps does (note: scoreMax=65 in no-log
        # case isn't enforced here — auto_retrain skips cases with < 10 prior
        # logs at build_cases:313 so hasLogs is always true).
        score = max(18, min(95, adjusted_raw * 100 + c.get('additive', 0.0)))
        lt = lock_thresholds.get(stat, b_lock)
        pt = play_thresholds.get(stat, b_play)
        if score >= lt:
            locks.append(c['label'])
        elif score >= pt:
            plays.append(c['label'])
    return locks, plays


def bootstrap_ci(labels, n_boot=2000, lo=0.05, hi=0.95, seed=42):
    """Percentile bootstrap CI for the mean of a 0/1 array.

    Returns (point_estimate, lower, upper). When labels is empty, returns (0,0,0).
    The seed is fixed so retrain runs are deterministic — week-over-week comparisons
    aren't muddied by bootstrap noise.
    """
    if not labels:
        return 0.0, 0.0, 0.0
    arr = np.asarray(labels, dtype=float)
    rng = np.random.default_rng(seed)
    n = len(arr)
    boots = rng.choice(arr, size=(n_boot, n), replace=True).mean(axis=1)
    return float(arr.mean()), float(np.quantile(boots, lo)), float(np.quantile(boots, hi))


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


def recalibrate_over_bias(grades, trailing_over_rates=None):
    """Compute stat-specific over_bias magnitude from over/under hit rate gap.

    Audit M1b 2026-05-23: previously computed gap across the FULL window,
    but in production the bias only fires when trailing 30d over-rate < 0.50
    (gate at lib/confidence.ts:overBiasAdj). The optimizer was therefore
    training as if bias always fires, and writing magnitudes calibrated to
    the broad window's gap — which under-states the actual gated-window gap.

    Fix: when trailing_over_rates is provided, restrict the magnitude
    calibration to the gated subset (props where trailing < 0.50 OR
    rate has no data — matching the production gate). The resulting bias
    magnitude is what's actually needed when the bias fires.

    Backward compatible: if trailing_over_rates is None, falls back to the
    full-window gap (legacy behavior).
    """
    bias = {}
    use_gate = trailing_over_rates is not None
    for stat in STAT_TYPES:
        def keep(g):
            # Always require the stat + hit-graded
            if g['stat_type'] != stat or g.get('hit') is None:
                return False
            if not use_gate:
                return True
            tr = trailing_over_rates.get((stat, g.get('game_date')))
            # Gate-firing window: trailing < 0.50 OR no data
            return tr is None or tr < 0.50

        overs  = [g for g in grades if keep(g) and g.get('direction') == 'over']
        unders = [g for g in grades if keep(g) and g.get('direction') == 'under']
        if len(overs) < 20 or len(unders) < 10:
            bias[stat] = -3
            continue
        o_hr = sum(1 for g in overs if g['hit']) / len(overs)
        u_hr = sum(1 for g in unders if g['hit']) / len(unders)
        gap = u_hr - o_hr
        raw_bias = round(gap * 30)
        bias[stat] = max(-10, min(0, -abs(raw_bias)))
    return bias


def _normalize_previous_weights(prev):
    """`previous_weights` has shipped in two shapes over the project's life:
       legacy:  { points: {...}, rebounds: {...}, ... }
       current: { weights: {points: {...}, ...}, lock_thresholds: {...}, ... }
    Normalize both to the current shape so rollback can read a single layout.
    Returns None if the dict is empty / clearly not weights."""
    if not prev:
        return None
    if 'weights' in prev and isinstance(prev['weights'], dict):
        return prev
    if any(stat in prev for stat in ('points', 'rebounds', 'assists', 'three_pointers', 'pra', 'steals', 'blocks')):
        return {
            'weights': prev,
            'lock_thresholds': {},
            'play_thresholds': {},
            'over_bias': {},
        }
    return None


def check_rollback(config, recent_grades, logs_by_player, def_stats_map):
    """
    Pre-flight: if last week's retrained weights *materially* degraded LOCK
    accuracy, roll back to previous_weights.

    Decision rule (post-2026-05): the UPPER 95% bootstrap CI of recent LOCK
    accuracy must fall below baseline - 3pp. This means we're 95% confident
    the model has gotten worse, not just unlucky. Plus a hard min-n=50 LOCK
    floor — anything less is sampling noise (the previous n>=10 floor was
    triggering rollbacks on a single bad week).

    Returns True if rollback was performed.
    """
    if not config:
        return False

    prev = _normalize_previous_weights(config.get('previous_weights'))
    if not prev:
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

    cur_locks, _ = score_cases_arrays(
        cases, config['weights'],
        config.get('lock_thresholds', {}),
        config.get('play_thresholds', {}),
        config.get('base_lock_threshold', 74),
        config.get('base_play_threshold', 68),
    )
    cur_lock_n = len(cur_locks)

    if cur_lock_n < 50:
        # Hard min-n: 50 LOCKs over 7 days is a reasonable threshold.
        # 16 LOCKs (the old n=10 floor) is dominated by sampling noise.
        cur_lock_hr = sum(cur_locks) / cur_lock_n if cur_lock_n else 0.0
        print(f"  Rollback check: only {cur_lock_n} recent LOCK predictions (need 50+), skipping. "
              f"baseline={baseline_lock:.1%} actual={cur_lock_hr:.1%}")
        return False

    cur_lock_hr, lo, hi = bootstrap_ci(cur_locks)
    print(f"  Rollback check: baseline LOCK={baseline_lock:.1%} | "
          f"actual={cur_lock_hr:.1%} [{lo:.1%}, {hi:.1%}] (n={cur_lock_n})")

    # Roll back only if the UPPER 95% CI of recent LOCK is materially below
    # baseline. "Materially" = 3pp, slightly tighter than the old 5pp drop on
    # the point estimate (because the upper-CI gate is already conservative).
    if hi < baseline_lock - 0.03:
        print(f"  ROLLBACK: upper-CI {hi:.1%} < baseline {baseline_lock:.1%} - 3pp = {baseline_lock - 0.03:.1%}")
        config['weights']          = prev['weights']
        config['lock_thresholds']  = prev.get('lock_thresholds', config.get('lock_thresholds', {}))
        config['play_thresholds']  = prev.get('play_thresholds', config.get('play_thresholds', {}))
        config['over_bias']        = prev.get('over_bias', config.get('over_bias', {}))
        config['previous_weights'] = None
        config['version']          = (config.get('previous_version') or config['version']) + '-rollback'
        config['last_retrained']   = datetime.now(timezone.utc).isoformat()
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

    print("  Loading player_line_bias...")
    bias_rows = sb_get_all('player_line_bias')
    player_bias_map = {(r['player_name'], r['stat_type']): r for r in bias_rows}
    print(f"  {len(player_bias_map):,} player×stat bias entries")

    print("  Loading opponent_stat_leaks...")
    leak_rows = sb_get_all('opponent_stat_leaks')
    opp_leak_map = {(r.get('opponent_team') or r.get('team'), r['stat_type']): r for r in leak_rows}
    print(f"  {len(opp_leak_map):,} (opp, stat) leak entries")

    # Build trailing 30-day over/under hit rate maps for over_bias/under_bias gates.
    # Point-in-time: at game_date G, rate for stat S = mean(hit) over props with
    # the same stat_type and direction graded in [G-30, G). Bins by date for
    # O(1) lookup during build_cases.
    print("  Computing point-in-time trailing 30-day hit rates...")
    trailing_over_rates = {}
    trailing_under_rates = {}
    all_dates = sorted(set(g['game_date'] for g in grades))
    grades_by_stat_dir_date = defaultdict(list)
    for g in grades:
        grades_by_stat_dir_date[(g['stat_type'], g.get('direction', 'over'))].append(g)
    for (stat, direction), gs in grades_by_stat_dir_date.items():
        # gs already chronological (build above iterates `grades` which is sorted by ASC)
        for d in all_dates:
            dt = datetime.strptime(d, '%Y-%m-%d')
            start = (dt - timedelta(days=30)).strftime('%Y-%m-%d')
            window = [x for x in gs if start <= x['game_date'] < d and x.get('hit') is not None]
            if len(window) < 20: continue
            hits = sum(1 for x in window if x['hit'])
            rate = hits / len(window)
            if direction == 'over':
                trailing_over_rates[(stat, d)] = rate
            else:
                trailing_under_rates[(stat, d)] = rate
    print(f"  {len(trailing_over_rates):,} (stat,date) over-rates / {len(trailing_under_rates):,} under-rates")

    # Yesterday-played-teams map for opponentB2bAdj. For each game_date G, find
    # teams that had ANY game on G-1 (from game logs).
    yesterday_teams_by_date = defaultdict(set)
    games_by_date = defaultdict(set)  # date -> set of teams that played
    for log in raw_logs:
        gd = log.get('game_date')
        m = log.get('matchup')
        if not gd or not m: continue
        # matchup like "OKC vs. SAS" or "SAS @ OKC"
        # Pull both teams to mark both as having played
        toks = re.split(r'\s+vs\.\s+|\s+@\s+', m)
        if len(toks) == 2:
            games_by_date[gd].add(toks[0].strip().upper())
            games_by_date[gd].add(toks[1].strip().upper())
    for d in all_dates:
        dt = datetime.strptime(d, '%Y-%m-%d')
        prev = (dt - timedelta(days=1)).strftime('%Y-%m-%d')
        yesterday_teams_by_date[d] = games_by_date.get(prev, set())

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
    print("\n[2/5] Building feature vectors + additives...")
    all_cases = build_cases(
        grades, logs_by_player, def_stats_map,
        player_bias_map=player_bias_map,
        opp_leak_map=opp_leak_map,
        trailing_over_rates=trailing_over_rates,
        trailing_under_rates=trailing_under_rates,
        yesterday_teams_by_date=yesterday_teams_by_date,
    )
    print(f"  {len(all_cases):,} matched cases")
    if all_cases:
        avg_add = sum(c.get('additive', 0) for c in all_cases) / len(all_cases)
        print(f"  avg additive total: {avg_add:+.2f} pts (mirrors production score-time adjustments)")

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

    # Audit M1b: pass trailing_over_rates so magnitude calibration restricts
    # to the SUBSET of windows where the gate would actually fire — mirrors
    # production scoring instead of training against an ungated phantom.
    new_over_bias = recalibrate_over_bias(grades, trailing_over_rates=trailing_over_rates)
    print(f"  Base thresholds: LOCK={base_lock} PLAY={base_play}")
    print(f"  Over bias: {new_over_bias}")

    # -- Validation ------------------------------------------------------------
    print("\n[5/5] Validating against held-out set...")

    new_locks, new_plays = score_cases_arrays(
        val_cases, new_weights, new_lock_thresholds, new_play_thresholds, base_lock, base_play
    )
    new_lock_hr, new_lock_lo, new_lock_hi = bootstrap_ci(new_locks)
    new_play_hr, new_play_lo, new_play_hi = bootstrap_ci(new_plays)
    print(f"  New weights:     LOCK {new_lock_hr:.1%} [{new_lock_lo:.1%}, {new_lock_hi:.1%}] (n={len(new_locks)})"
          f" | PLAY {new_play_hr:.1%} [{new_play_lo:.1%}, {new_play_hi:.1%}] (n={len(new_plays)})")

    current_config = None
    try:
        with open(JSON_PATH) as f:
            current_config = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        pass

    cur_lock_hr = 0.0
    cur_play_hr = 0.0
    cur_lock_n = 0
    cur_play_n = 0
    if current_config and current_config.get('weights'):
        cur_locks, cur_plays = score_cases_arrays(
            val_cases, current_config['weights'],
            current_config.get('lock_thresholds', {}),
            current_config.get('play_thresholds', {}),
            current_config.get('base_lock_threshold', 74),
            current_config.get('base_play_threshold', 68),
        )
        cur_lock_hr, _, _ = bootstrap_ci(cur_locks)
        cur_play_hr, _, _ = bootstrap_ci(cur_plays)
        cur_lock_n, cur_play_n = len(cur_locks), len(cur_plays)
        print(f"  Current weights: LOCK {cur_lock_hr:.1%} (n={cur_lock_n}) | PLAY {cur_play_hr:.1%} (n={cur_play_n})")

    # -- Adoption decision (gated on bootstrap lower-CI, not point estimate) ---
    # Old gate just compared point estimates, which on small LOCK samples
    # (n=14 type tiers) is dominated by sampling noise. Now require:
    #   1. Lower 5% bootstrap CI of new LOCK >= current LOCK point estimate
    #      (i.e. we are 95% confident new is at least as good as current).
    #   2. Combined point-estimate improvement >= 0.5%.
    #   3. At least 20 LOCK predictions in val.
    new_combined = 0.6 * new_lock_hr + 0.4 * new_play_hr
    cur_combined = 0.6 * cur_lock_hr + 0.4 * cur_play_hr
    improvement = new_combined - cur_combined

    ci_passes = new_lock_lo >= cur_lock_hr  # lower bound of new beats point estimate of current

    adopt = (
        ci_passes and
        improvement >= 0.005 and
        len(new_locks) >= 20
    )

    if not adopt:
        reasons = []
        if not ci_passes:
            reasons.append(f"LOCK lower-CI {new_lock_lo:.1%} < current point {cur_lock_hr:.1%}")
        if improvement < 0.005:
            reasons.append(f"improvement too small ({improvement:+.1%})")
        if len(new_locks) < 20:
            reasons.append(f"too few LOCKs ({len(new_locks)})")
        print(f"\n  REJECTED: {', '.join(reasons)}")
        print("  Keeping current weights.")
        sys.exit(0)

    print(f"\n  ADOPTED: improvement {improvement:+.1%} (combined {cur_combined:.1%} -> {new_combined:.1%})")
    print(f"  LOCK lower-CI {new_lock_lo:.1%} clears current point estimate {cur_lock_hr:.1%}.")
    new_lock_n = len(new_locks)
    new_play_n = len(new_plays)

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
            'lock_ci_90': [round(float(new_lock_lo), 4), round(float(new_lock_hi), 4)],
            'play_ci_90': [round(float(new_play_lo), 4), round(float(new_play_hi), 4)],
            'lock_n': int(new_lock_n),
            'play_n': int(new_play_n),
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
