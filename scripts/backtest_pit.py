"""
Point-In-Time Backtest for NBA IQ Confidence Model
===================================================
Eliminates look-ahead bias by computing ALL factors using only data
available BEFORE each prop's game date.

Two modes:
  --mode real       : prop_history + prop_grades only (last N days)
  --mode synthetic  : augments each real prop with ±1/±2 alt lines

Usage:
  py -3.13 scripts/backtest_pit.py --mode real --days 40
  py -3.13 scripts/backtest_pit.py --mode synthetic --days 40
  py -3.13 scripts/backtest_pit.py --mode both --days 40
"""

import os, sys, json, argparse, math, re
from collections import defaultdict
from datetime import datetime, timedelta, date
import numpy as np

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

import requests

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

# ── Helper utilities ──────────────────────────────────────────────────────────
def clamp(v, lo=0.0, hi=1.0):
    return max(lo, min(hi, v))

def get_stat(log, stat_type):
    mapping = {
        'points':         'points',
        'rebounds':       'rebounds',
        'assists':        'assists',
        'steals':         'steals',
        'blocks':         'blocks',
        'three_pointers': 'fg3m',
        'pra':            'pra',
    }
    return float(log.get(mapping.get(stat_type, stat_type), 0) or 0)

def extract_opponent(matchup):
    """Extract opponent abbreviation from matchup string like 'BOS @ MIA' or 'BOS vs. MIA'."""
    if not matchup:
        return None
    if ' @ ' in matchup:
        parts = matchup.split(' @ ')
        # The player's team is on the left, opponent is on the right
        return parts[1].strip().split()[0] if len(parts) > 1 else None
    if ' vs. ' in matchup:
        parts = matchup.split(' vs. ')
        # Home team is on the left, away team on the right
        return parts[1].strip().split()[0] if len(parts) > 1 else None
    return None

def get_player_team(matchup, is_home):
    """Extract player's team abbreviation."""
    if not matchup:
        return None
    if ' @ ' in matchup:
        parts = matchup.split(' @ ')
        return (parts[1] if is_home else parts[0]).strip().split()[0]
    if ' vs. ' in matchup:
        parts = matchup.split(' vs. ')
        return (parts[0] if is_home else parts[1]).strip().split()[0]
    return None

# ── Scoring functions (mirrors TypeScript logic) ──────────────────────────────

def line_value_score(logs, stat_type, line, direction):
    recent = [get_stat(g, stat_type) for g in logs[:10] if get_stat(g, stat_type) >= 0]
    if len(recent) < 5:
        return 0.50
    mean = sum(recent) / len(recent)
    variance = sum((v - mean) ** 2 for v in recent) / len(recent)
    stdev = math.sqrt(variance)
    if stdev < 0.5:
        return 0.50
    z = (mean - line) / stdev if direction == 'over' else (line - mean) / stdev
    return clamp(0.50 + z * 0.28)

def season_cushion_score(logs, stat_type, line, direction):
    """Uses only logs before the game date (no external season stats)."""
    vals = [get_stat(g, stat_type) for g in logs if get_stat(g, stat_type) >= 0]
    if len(vals) < 5:
        return 0.50
    avg = sum(vals) / len(vals)
    pct = (avg - line) / max(line, 1)
    raw = clamp(pct / 0.60 + 0.50)
    return raw if direction == 'over' else 1 - raw

def hit_rate_score(logs, stat_type, line, direction, n=20):
    active = [g for g in logs if float(g.get('minutes', 0) or 0) >= 5]
    slice_ = active[:n]
    if len(slice_) < 3:
        return None
    weighted_hits = 0.0
    total_weight = 0.0
    for i, g in enumerate(slice_):
        w = 0.93 ** i
        hit = get_stat(g, stat_type) > line if direction == 'over' else get_stat(g, stat_type) < line
        weighted_hits += w if hit else 0
        total_weight += w
    return weighted_hits / total_weight

def trend_score(logs, stat_type, direction):
    l5  = [get_stat(g, stat_type) for g in logs[:5]]
    l20 = [get_stat(g, stat_type) for g in logs[:20]]
    if len(l5) < 3 or len(l20) < 8:
        return 0.50
    avg5  = sum(l5)  / len(l5)
    avg20 = sum(l20) / len(l20)
    if avg20 == 0:
        return 0.50
    trend_pct = (avg5 - avg20) / avg20
    raw = clamp(trend_pct / 0.40 + 0.50)
    return raw if direction == 'over' else 1 - raw

def matchup_score(def_ranks, stat_type, direction):
    """
    def_ranks: dict keyed by team_abbr -> { 'pts_rank':N, 'reb_rank':N, ... }
    Returns 0.5 if no data.
    """
    rank_key = {
        'points': 'pts_rank', 'rebounds': 'reb_rank', 'assists': 'ast_rank',
        'steals': 'stl_rank', 'blocks': 'blk_rank', 'three_pointers': 'fg3m_rank',
        'pra': 'pts_rank',  # proxy
    }.get(stat_type)
    if not rank_key or not def_ranks or rank_key not in def_ranks:
        return 0.50
    rank = def_ranks[rank_key]
    if not rank or rank < 1 or rank > 30:
        return 0.50
    raw = (rank - 1) / 29
    return raw if direction == 'over' else 1 - raw

def rest_days_score(logs, game_date_str):
    if not logs:
        return 0.50
    last = logs[0].get('game_date', '')
    if not last:
        return 0.50
    try:
        gap = (datetime.strptime(game_date_str, '%Y-%m-%d') - datetime.strptime(last, '%Y-%m-%d')).days - 1
    except:
        return 0.50
    if gap <= 0:  return 0.25
    if gap == 1:  return 0.50
    if gap == 2:  return 0.60
    return 0.55

def home_away_score(logs, stat_type, line, direction, is_home):
    if is_home is None:
        return None
    filtered = [g for g in logs if g.get('is_home') == is_home]
    if len(filtered) < 5:
        return None
    hits = sum(1 for g in filtered if
               (get_stat(g, stat_type) > line if direction == 'over' else get_stat(g, stat_type) < line))
    return hits / len(filtered)

def vs_opponent_score(logs, stat_type, line, direction, opponent_abbr):
    if not opponent_abbr:
        return 0.50
    vs_logs = [g for g in logs if
               (extract_opponent(g.get('matchup', '')) or '').upper() == opponent_abbr.upper()]
    if len(vs_logs) < 2:
        return 0.50
    hits = sum(1 for g in vs_logs if
               (get_stat(g, stat_type) > line if direction == 'over' else get_stat(g, stat_type) < line))
    raw_rate = hits / len(vs_logs)
    weight = min(0.80, 0.15 + len(vs_logs) * 0.13)
    return raw_rate * weight + 0.50 * (1 - weight)

def blowout_score(spread):
    if spread is None: return 0.50
    s = abs(float(spread))
    if s <= 3:  return 0.50
    if s <= 6:  return 0.47
    if s <= 9:  return 0.44
    if s <= 12: return 0.41
    return 0.37

def data_freshness(logs, game_date_str):
    if not logs:
        return 0.70
    last = logs[0].get('game_date', '')
    if not last:
        return 0.70
    try:
        gap = (datetime.strptime(game_date_str, '%Y-%m-%d') - datetime.strptime(last, '%Y-%m-%d')).days
    except:
        return 0.70
    if gap > 90: return 0.15
    if gap > 45: return 0.35
    if gap > 21: return 0.55
    if gap > 14: return 0.72
    if gap > 7:  return 0.88
    return 1.00

# ── Per-stat weights (mirrors TypeScript) ────────────────────────────────────

WEIGHTS = {
    'points': dict(lineValue=0.13, matchupEdge=0.06, last20HitRate=0.15, trend=0.06,
                   seasonCushion=0.04, pace=0.11, newsInjury=0.06, restDays=0.16,
                   blowout=0.12, homeAway=0.08, vsOpponent=0.03),
    'rebounds': dict(lineValue=0.03, matchupEdge=0.09, last20HitRate=0.18, trend=0.08,
                     seasonCushion=0.10, pace=0.10, newsInjury=0.13, restDays=0.10,
                     blowout=0.10, homeAway=0.07, vsOpponent=0.02),
    'assists': dict(lineValue=0.08, matchupEdge=0.07, last20HitRate=0.13, trend=0.09,
                    seasonCushion=0.16, pace=0.07, newsInjury=0.12, restDays=0.06,
                    blowout=0.04, homeAway=0.06, vsOpponent=0.12),
    'pra': dict(lineValue=0.05, matchupEdge=0.07, last20HitRate=0.08, trend=0.16,
                seasonCushion=0.28, pace=0.03, newsInjury=0.08, restDays=0.04,
                blowout=0.13, homeAway=0.09, vsOpponent=0.03),
    'blocks': dict(lineValue=0.05, matchupEdge=0.13, last20HitRate=0.19, trend=0.10,
                   seasonCushion=0.26, pace=0.05, newsInjury=0.08, restDays=0.04,
                   blowout=0.06, homeAway=0.05, vsOpponent=0.07),
    'steals': dict(lineValue=0.10, matchupEdge=0.09, last20HitRate=0.23, trend=0.12,
                   seasonCushion=0.14, pace=0.04, newsInjury=0.06, restDays=0.13,
                   blowout=0.03, homeAway=0.04, vsOpponent=0.05),
    'three_pointers': dict(lineValue=0.05, matchupEdge=0.07, last20HitRate=0.26, trend=0.13,
                           seasonCushion=0.07, pace=0.05, newsInjury=0.04, restDays=0.24,
                           blowout=0.04, homeAway=0.15, vsOpponent=0.01),
}

LOCK_THRESHOLD = {'assists': 74, 'pra': 78, 'steals': 78, 'blocks': 74, 'three_pointers': 72, 'rebounds': 76}
PLAY_THRESHOLD = {'assists': 68, 'pra': 72, 'steals': 72, 'blocks': 68, 'three_pointers': 66, 'rebounds': 70}
LOCK_DEFAULT = 72  # raised from 68 — scores <70 hit ~49% in calibration
PLAY_DEFAULT = 66  # raised from 60 — LOCK - 6

def get_label(score, stat_type):
    lock = LOCK_THRESHOLD.get(stat_type, LOCK_DEFAULT)
    play = PLAY_THRESHOLD.get(stat_type, PLAY_DEFAULT)
    if score >= lock: return 'LOCK'
    if score >= play: return 'PLAY'
    if score >= 50:   return 'LEAN'
    return 'FADE'

def score_prop_pit(prop, player_logs_before, def_ranks_before, weights=None):
    """
    Score a prop using ONLY data available before prop['game_date'].
    player_logs_before: list of game logs sorted desc by game_date, all before game_date
    def_ranks_before:   dict of opp_team -> rank stats computed from data before game_date
    """
    stat_type  = prop['stat_type']
    direction  = prop['direction']
    line       = float(prop['line'])
    game_date  = prop['game_date']
    opponent   = prop.get('opponent_abbr')  # extracted externally
    is_home    = prop.get('is_home')

    Wt = weights or WEIGHTS.get(stat_type, WEIGHTS['points'])
    logs = player_logs_before

    has_logs = len(logs) >= 3

    if not has_logs:
        # No log fallback: use matchup + cushion + injury proxy
        f2   = matchup_score(def_ranks_before, stat_type, direction)
        f3   = 0.50
        f11  = 0.50  # no injury data in backtest
        raw  = f2 * 0.50 + f3 * 0.30 + f11 * 0.20
        score = round(clamp(raw * 100, 18, 65))
        return score, get_label(score, stat_type)

    fLineValue = line_value_score(logs, stat_type, line, direction)
    f2         = matchup_score(def_ranks_before, stat_type, direction)
    f3         = season_cushion_score(logs, stat_type, line, direction)
    f4_val     = vs_opponent_score(logs, stat_type, line, direction, opponent)
    f5_val     = home_away_score(logs, stat_type, line, direction, is_home)
    f6         = trend_score(logs, stat_type, direction)
    f7_val     = hit_rate_score(logs, stat_type, line, direction)
    # f10 (blowout) needs spread — not available in prop_history; use neutral
    f10        = 0.50
    # f11 (news/injury) — not available in backtest; use neutral
    f11        = 0.50
    f12        = rest_days_score(logs, game_date)
    # fPace — not available without historical team pace; use neutral
    fPace      = 0.50

    # Neutral fallbacks
    f4 = f4_val if f4_val is not None else 0.50
    f5 = f5_val if f5_val is not None else 0.50
    f7 = f7_val if f7_val is not None else 0.50

    raw = (
        fLineValue * Wt['lineValue']      +
        f2         * Wt['matchupEdge']    +
        f7         * Wt['last20HitRate']  +
        f6         * Wt['trend']          +
        f3         * Wt['seasonCushion']  +
        fPace      * Wt['pace']           +
        f11        * Wt['newsInjury']     +
        f12        * Wt['restDays']       +
        f10        * Wt['blowout']        +
        f5         * Wt['homeAway']       +
        f4         * Wt['vsOpponent']
    )

    freshness    = data_freshness(logs, game_date)
    adjusted_raw = 0.50 + (raw - 0.50) * freshness

    # Consensus bonus/penalty
    primary = [fLineValue, f2, f7, f6, f3]
    agree_count = sum(1 for f in primary if f >= 0.55)
    consensus = 3 if agree_count >= 4 else 0 if agree_count >= 3 else -4 if agree_count >= 2 else -10

    # Over bias correction (empirical)
    over_bias = -3 if direction == 'over' else 0

    # Minutes uncertainty (approximate from logs)
    m_recent = [float(g.get('minutes', 0) or 0) for g in logs[:10] if float(g.get('minutes', 0) or 0) >= 1]
    minutes_penalty = 0
    if len(m_recent) >= 4:
        avg_mins = sum(m_recent) / len(m_recent)
        variance = sum((m - avg_mins) ** 2 for m in m_recent) / len(m_recent)
        stdev_mins = math.sqrt(variance)
        if avg_mins < 20:
            minutes_penalty = -8
        elif avg_mins < 24:
            minutes_penalty = -4
        if stdev_mins > 6:
            minutes_penalty -= 3

    score = round(clamp(
        adjusted_raw * 100 + consensus * freshness + over_bias + minutes_penalty,
        18, 95
    ))
    return score, get_label(score, stat_type)


# ── Build point-in-time defense ranks from game logs ─────────────────────────

def build_def_ranks_by_date(all_logs):
    """
    For each unique game_date in logs, compute defensive ranks using
    only games played BEFORE that date.
    Returns: dict of game_date -> dict of team_abbr -> rank stats
    """
    print("Building point-in-time defense ranks from game logs...")
    # Sort logs by date
    all_logs_sorted = sorted(all_logs, key=lambda g: g.get('game_date', ''))

    # Get all unique dates
    dates = sorted(set(g['game_date'] for g in all_logs_sorted if g.get('game_date')))

    # For each date, aggregate opponent stats allowed per team
    # We'll build this incrementally
    # team_stats[team][stat] = list of per-game averages opponent scored against this team
    team_game_stats = defaultdict(lambda: defaultdict(list))  # team -> stat -> [values per game]
    team_game_dates = defaultdict(list)  # team -> [dates of games]

    STAT_KEYS = ['points', 'rebounds', 'assists', 'steals', 'blocks', 'fg3m']
    RANK_KEYS = ['pts_rank', 'reb_rank', 'ast_rank', 'stl_rank', 'blk_rank', 'fg3m_rank']

    # Group game logs by (game_date, matchup_team) to get per-game stats
    # For each game, identify the defending team and stats scored against them
    game_groups = defaultdict(list)  # (game_date, opp_team) -> [logs]
    for g in all_logs_sorted:
        opp = extract_opponent(g.get('matchup', ''))
        if opp and g.get('game_date'):
            game_groups[(g['game_date'], opp)].append(g)

    # Compute per-game totals for each team defending
    # game_totals[team][game_date] = {stat: total}
    game_totals = defaultdict(dict)  # team -> game_date -> stat totals
    for (gdate, opp_team), logs in game_groups.items():
        totals = {s: sum(get_stat(g, s if s != 'fg3m' else 'three_pointers') for g in logs) for s in STAT_KEYS}
        game_totals[opp_team][gdate] = totals

    # Build sorted list of (date, team, totals) for incremental computation
    all_game_events = []
    for team, date_map in game_totals.items():
        for gdate, totals in date_map.items():
            all_game_events.append((gdate, team, totals))
    all_game_events.sort()

    # Build ranks for each unique prop date
    def_ranks_by_date = {}
    team_running = defaultdict(lambda: defaultdict(list))  # team -> stat -> [game totals]
    event_idx = 0

    for prop_date in dates:
        # Add all game events strictly before this prop_date
        while event_idx < len(all_game_events) and all_game_events[event_idx][0] < prop_date:
            gdate, team, totals = all_game_events[event_idx]
            for s in STAT_KEYS:
                team_running[team][s].append(totals[s])
            event_idx += 1

        # Compute averages and ranks for all teams
        if not team_running:
            def_ranks_by_date[prop_date] = {}
            continue

        team_avgs = {}
        for team, stat_map in team_running.items():
            avgs = {}
            for s in STAT_KEYS:
                vals = stat_map[s]
                avgs[s] = sum(vals) / len(vals) if vals else 0
            team_avgs[team] = avgs

        # Rank teams (1 = best defense = fewest allowed)
        team_ranks = {team: {} for team in team_avgs}
        for s, rank_key in zip(STAT_KEYS, RANK_KEYS):
            sorted_teams = sorted(team_avgs.keys(), key=lambda t: team_avgs[t][s])
            for rank, team in enumerate(sorted_teams, 1):
                team_ranks[team][rank_key] = rank

        def_ranks_by_date[prop_date] = team_ranks

    print(f"  Built ranks for {len(def_ranks_by_date)} unique dates across {len(team_running)} teams")
    return def_ranks_by_date


# ── Synthetic alt line generation ────────────────────────────────────────────

STEP = {'points': 2, 'pra': 2, 'rebounds': 1, 'assists': 1,
        'steals': 1, 'blocks': 1, 'three_pointers': 1}

def generate_synthetic_props(real_props):
    """For each real prop, add ±1 and ±2 step alt lines with the same result logic."""
    synthetic = []
    for p in real_props:
        step = STEP.get(p['stat_type'], 1)
        for delta in [-2, -1, 1, 2]:
            alt_line = round(p['line'] + delta * step, 1)
            if alt_line < 0.5:
                continue
            # The result changes: if original OVER hit at line 24.5, does OVER hit at 22.5?
            # We can infer from the actual_value stored in grades if available
            actual = p.get('actual_value')
            if actual is None:
                continue  # skip synthetics without actual value
            result = 'hit' if (
                (p['direction'] == 'over'  and float(actual) > alt_line) or
                (p['direction'] == 'under' and float(actual) < alt_line)
            ) else 'miss'
            synthetic.append({**p, 'line': alt_line, 'result': result, 'is_synthetic': True})
    return synthetic


# ── Optimizer ─────────────────────────────────────────────────────────────────

def dirichlet_optimize(props_with_factors, stat_type, n_samples=5000, seed=42):
    """
    Find weights maximising LOCK hit rate on point-in-time factors.
    Returns (best_weights, best_lock_accuracy, n_locks)
    """
    rng = np.random.default_rng(seed)
    factor_keys = ['lineValue', 'matchupEdge', 'last20HitRate', 'trend',
                   'seasonCushion', 'pace', 'newsInjury', 'restDays',
                   'blowout', 'homeAway', 'vsOpponent']

    lock_thresh = LOCK_THRESHOLD.get(stat_type, 68)

    # Extract factor vectors and results
    records = [(p['factors'], p['result']) for p in props_with_factors
               if p['stat_type'] == stat_type and p.get('result') in ('hit', 'miss')]
    if len(records) < 15:
        return None, None, 0

    best_acc  = -1
    best_hits = 0
    best_n    = 0
    best_w    = None

    for _ in range(n_samples):
        w_raw = rng.dirichlet(np.ones(len(factor_keys)))
        w = dict(zip(factor_keys, w_raw))

        lock_hits = lock_total = 0
        for factors, result in records:
            s, _ = score_prop_pit_from_factors(factors, w, stat_type)
            if s >= lock_thresh:
                lock_total += 1
                if result == 'hit':
                    lock_hits += 1

        if lock_total >= 10:
            acc = lock_hits / lock_total
            if acc > best_acc or (acc == best_acc and lock_total > best_n):
                best_acc  = acc
                best_hits = lock_hits
                best_n    = lock_total
                best_w    = w.copy()

    return best_w, best_acc, best_n


def score_prop_pit_from_factors(factors, weights, stat_type):
    """Apply weights to pre-computed factors dict."""
    f = factors
    has_logs = f.get('has_logs', True)

    if not has_logs:
        raw = f['f2'] * 0.50 + f['f3'] * 0.30 + 0.50 * 0.20
    else:
        raw = (
            f['fLineValue'] * weights['lineValue']      +
            f['f2']         * weights['matchupEdge']    +
            f['f7']         * weights['last20HitRate']  +
            f['f6']         * weights['trend']          +
            f['f3']         * weights['seasonCushion']  +
            f['fPace']      * weights['pace']           +
            f['f11']        * weights['newsInjury']     +
            f['f12']        * weights['restDays']       +
            f['f10']        * weights['blowout']        +
            f['f5']         * weights['homeAway']       +
            f['f4']         * weights['vsOpponent']
        )

    freshness    = f.get('freshness', 1.0)
    adjusted_raw = 0.50 + (raw - 0.50) * freshness
    consensus    = f.get('consensus', 0)
    over_bias    = f.get('over_bias', 0)
    min_penalty  = f.get('minutes_penalty', 0)

    score = round(clamp(
        adjusted_raw * 100 + consensus * freshness + over_bias + min_penalty,
        18, 95
    ))
    return score, get_label(score, stat_type)


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode',  choices=['real', 'synthetic', 'both'], default='both')
    parser.add_argument('--days',  type=int, default=55,
                        help='Days back from today to include (default 55 covers all of historical_prop_lines)')
    parser.add_argument('--optimize', action='store_true', help='Run weight optimizer after eval')
    args = parser.parse_args()

    cutoff_date = (datetime.today() - timedelta(days=args.days)).strftime('%Y-%m-%d')
    print(f"\nPoint-In-Time Backtest (mode={args.mode}, days={args.days}, cutoff={cutoff_date})")
    print("=" * 70)

    # ── Load data ──────────────────────────────────────────────────────────────
    print("\n[1/4] Loading real prop lines from historical_prop_lines (Odds API only)...")
    # Use historical_prop_lines — these are real market lines from The Odds API backfill.
    # Deduplicate: keep only one row per (player, stat, line, direction, game_date).
    # We pick OVER only here since UNDER is just the mirror — avoids doubling the dataset.
    # The model is symmetric (overBiasAdj handles direction differences).
    history_raw = supabase_get_all(
        'historical_prop_lines',
        f'select=player_name,stat_type,direction,line,game_date,commence_time,home_team,away_team&game_date=gte.{cutoff_date}&direction=eq.over&order=game_date.asc'
    )
    # Deduplicate: one prop per (player, stat, line, game_date) — take the first occurrence
    seen_props = set()
    history = []
    for h in history_raw:
        key = f"{h['game_date']}|{h['player_name']}|{h['stat_type']}|{h['line']}"
        if key not in seen_props:
            seen_props.add(key)
            history.append(h)
    print(f"  {len(history_raw)} raw rows -> {len(history)} deduped real props loaded")
    print(f"  Date range: {history[0]['game_date'] if history else 'n/a'} to {history[-1]['game_date'] if history else 'n/a'}")
    unique_dates = sorted(set(h['game_date'] for h in history))
    print(f"  {len(unique_dates)} unique dates: {unique_dates[0]} to {unique_dates[-1]}")

    print("[2/4] Loading prop grades (real actual values only, no nulls)...")
    grades_raw = supabase_get_all(
        'prop_grades',
        f'select=player_name,stat_type,line,direction,game_date,hit,actual_value&game_date=gte.{cutoff_date}&hit=not.is.null&actual_value=not.is.null'
    )
    # Key: (game_date, player_name, stat_type, line) — direction-agnostic since actual_value
    # is the same for OVER and UNDER on the same prop. We'll derive result from actual_value.
    grade_map = {}
    for g in grades_raw:
        key = f"{g['game_date']}|{g['player_name']}|{g['stat_type']}|{g['line']}"
        if key not in grade_map:
            grade_map[key] = g
    print(f"  {len(grades_raw)} raw grade rows -> {len(grade_map)} unique props with actual values")

    print("[3/4] Loading player game logs (all history for point-in-time factors)...")
    all_logs = supabase_get_all(
        'player_game_logs',
        'select=player_name,game_date,matchup,is_home,points,rebounds,assists,steals,blocks,fg3m,pra,minutes&order=game_date.asc'
    )
    print(f"  {len(all_logs)} game log rows loaded")

    # Index logs by player (sorted desc by date for easy slicing)
    logs_by_player = defaultdict(list)
    for g in sorted(all_logs, key=lambda x: x.get('game_date', ''), reverse=True):
        logs_by_player[g['player_name']].append(g)

    print("[4/4] Building point-in-time defense ranks...")
    def_ranks_by_date = build_def_ranks_by_date(all_logs)

    # ── Build scored props dataset ─────────────────────────────────────────────
    print("\nScoring props with point-in-time factors...")

    # Join grades → history using direction-agnostic key (actual_value is the same for O/U)
    # Result for OVER is derived from actual_value vs line directly (no dependency on stored hit flag)
    graded_props = []
    no_grade = 0
    for h in history:
        key = f"{h['game_date']}|{h['player_name']}|{h['stat_type']}|{h['line']}"
        grade = grade_map.get(key)
        if not grade:
            no_grade += 1
            continue
        actual = grade.get('actual_value')
        if actual is None:
            continue
        line = float(h['line'])
        direction = h['direction']  # always 'over' since we filtered above
        result = 'hit' if float(actual) > line else 'miss'
        h['result']       = result
        h['actual_value'] = actual
        graded_props.append(h)

    print(f"  {len(graded_props)} graded props ({no_grade} no grade found, skipped)")
    by_date = {}
    for p in graded_props:
        by_date.setdefault(p['game_date'], 0)
        by_date[p['game_date']] += 1
    print(f"  Graded dates: {sorted(by_date.keys())[0]} to {sorted(by_date.keys())[-1]} ({len(by_date)} days)")

    # Enrich props with opponent info from game logs
    def get_opponent_and_home(player_name, game_date):
        plogs = [g for g in logs_by_player[player_name] if g['game_date'] < game_date]
        # Find the game on game_date if it exists in logs
        same_day = [g for g in logs_by_player[player_name] if g['game_date'] == game_date]
        if same_day:
            g = same_day[0]
            return extract_opponent(g.get('matchup', '')), g.get('is_home')
        return None, None

    # Score each prop
    all_scored = []
    for p in graded_props:
        game_date  = p['game_date']
        player     = p['player_name']
        stat_type  = p['stat_type']
        direction  = p['direction']
        line       = float(p['line'])

        # Logs strictly before game_date
        plogs = [g for g in logs_by_player[player] if g['game_date'] < game_date]

        # Defense ranks as of game_date
        def_ranks_date = def_ranks_by_date.get(game_date, {})

        # Get opponent
        opp, is_home = get_opponent_and_home(player, game_date)
        p['opponent_abbr'] = opp
        p['is_home']       = is_home

        opp_def_ranks = def_ranks_date.get(opp, {}) if opp else {}

        score, label = score_prop_pit(p, plogs, opp_def_ranks)

        # Also store pre-computed factors for optimizer
        has_logs = len(plogs) >= 3
        factors = {
            'has_logs':      has_logs,
            'fLineValue':    line_value_score(plogs, stat_type, line, direction) if has_logs else 0.50,
            'f2':            matchup_score(opp_def_ranks, stat_type, direction),
            'f3':            season_cushion_score(plogs, stat_type, line, direction) if has_logs else 0.50,
            'f4':            vs_opponent_score(plogs, stat_type, line, direction, opp) if has_logs else 0.50,
            'f5':            (home_away_score(plogs, stat_type, line, direction, is_home) or 0.50) if has_logs else 0.50,
            'f6':            trend_score(plogs, stat_type, direction) if has_logs else 0.50,
            'f7':            (hit_rate_score(plogs, stat_type, line, direction) or 0.50) if has_logs else 0.50,
            'f10':           0.50,  # blowout: no spread data in backtest
            'f11':           0.50,  # injury: not available
            'f12':           rest_days_score(plogs, game_date) if has_logs else 0.50,
            'fPace':         0.50,  # pace: no historical team pace
            'freshness':     data_freshness(plogs, game_date) if has_logs else 0.70,
            'over_bias':     -3 if direction == 'over' else 0,
            'minutes_penalty': 0,  # computed inside score_prop_pit
        }
        primary = [factors['fLineValue'], factors['f2'], factors['f7'], factors['f6'], factors['f3']]
        agree = sum(1 for f in primary if f >= 0.55)
        factors['consensus'] = 3 if agree >= 4 else 0 if agree >= 3 else -4 if agree >= 2 else -10

        all_scored.append({
            **p,
            'pit_score': score,
            'pit_label': label,
            'factors':   factors,
        })

    # ── Generate synthetic props ───────────────────────────────────────────────
    if args.mode in ('synthetic', 'both'):
        synthetic = generate_synthetic_props(all_scored)
        print(f"  Generated {len(synthetic)} synthetic alt-line props")
        # Score synthetics too
        for p in synthetic:
            score, label = score_prop_pit(p,
                [g for g in logs_by_player[p['player_name']] if g['game_date'] < p['game_date']],
                def_ranks_by_date.get(p['game_date'], {}).get(p.get('opponent_abbr', ''), {}))
            p['pit_score'] = score
            p['pit_label'] = label

    # ── Evaluate accuracy ──────────────────────────────────────────────────────
    def evaluate(props, mode_name):
        print(f"\n{'='*70}")
        print(f"RESULTS: {mode_name} ({len(props)} props)")
        print(f"{'='*70}")

        stats_order = ['points', 'rebounds', 'assists', 'three_pointers', 'pra', 'blocks', 'steals']

        overall_by_label = defaultdict(lambda: {'hits': 0, 'total': 0})
        by_stat = defaultdict(lambda: defaultdict(lambda: {'hits': 0, 'total': 0}))
        score_buckets = defaultdict(lambda: {'hits': 0, 'total': 0})

        for p in props:
            result = p['result']
            label  = p['pit_label']
            stat   = p['stat_type']
            score  = p['pit_score']

            overall_by_label[label]['total'] += 1
            if result == 'hit':
                overall_by_label[label]['hits'] += 1

            by_stat[stat][label]['total'] += 1
            if result == 'hit':
                by_stat[stat][label]['hits'] += 1

            bucket = (score // 5) * 5
            score_buckets[bucket]['total'] += 1
            if result == 'hit':
                score_buckets[bucket]['hits'] += 1

        print("\nOVERALL by label:")
        for lbl in ['LOCK', 'PLAY', 'LEAN', 'FADE']:
            d = overall_by_label[lbl]
            if d['total'] > 0:
                acc = d['hits'] / d['total']
                print(f"  {lbl:5s}: {d['hits']:3d}/{d['total']:3d} = {acc:.1%}")

        print("\nPER-STAT LOCK accuracy:")
        for stat in stats_order:
            d = by_stat[stat]['LOCK']
            d2 = by_stat[stat]['PLAY']
            if d['total'] > 0 or d2['total'] > 0:
                lock_acc  = f"{d['hits']}/{d['total']} = {d['hits']/d['total']:.1%}" if d['total'] else 'n/a'
                play_acc  = f"{d2['hits']}/{d2['total']} = {d2['hits']/d2['total']:.1%}" if d2['total'] else 'n/a'
                print(f"  {stat:16s}  LOCK {lock_acc:20s}  PLAY {play_acc}")

        print("\nCalibration by score bucket:")
        for bucket in sorted(score_buckets):
            d = score_buckets[bucket]
            if d['total'] >= 5:
                acc = d['hits'] / d['total']
                bar = '#' * int(acc * 20)
                print(f"  [{bucket:2d}-{bucket+4:2d}] {d['hits']:3d}/{d['total']:3d} = {acc:.1%}  {bar}")

        return overall_by_label, by_stat

    if args.mode in ('real', 'both'):
        evaluate(all_scored, f"Real props (last {args.days} days, point-in-time)")

    if args.mode in ('synthetic', 'both'):
        synth_scored = [p for p in all_scored]  # start with real
        synth_scored += generate_synthetic_props(all_scored)
        # Re-score synthetics
        synth_final = []
        for p in synth_scored:
            if p.get('is_synthetic'):
                plogs = [g for g in logs_by_player[p['player_name']] if g['game_date'] < p['game_date']]
                opp_def = def_ranks_by_date.get(p['game_date'], {}).get(p.get('opponent_abbr', ''), {})
                score, label = score_prop_pit(p, plogs, opp_def)
                p['pit_score'] = score
                p['pit_label'] = label
                p['factors'] = all_scored[0]['factors']  # placeholder — will be overwritten
            synth_final.append(p)
        evaluate(synth_final, f"Real + synthetic props (last {args.days} days, point-in-time)")

    # ── Weight optimization ────────────────────────────────────────────────────
    if args.optimize:
        print(f"\n{'='*70}")
        print("WEIGHT OPTIMIZATION (point-in-time Dirichlet search)")
        print(f"{'='*70}")

        stat_types = ['points', 'rebounds', 'assists', 'three_pointers', 'pra', 'blocks', 'steals']
        optimized = {}

        for stat in stat_types:
            stat_props = [p for p in all_scored if p['stat_type'] == stat]
            graded = [p for p in stat_props if p.get('result') in ('hit', 'miss')]
            if len(graded) < 20:
                print(f"  {stat:16s}: skip (only {len(graded)} graded props)")
                continue
            print(f"  Optimizing {stat} ({len(graded)} props)...", end=' ', flush=True)
            best_w, best_acc, n_locks = dirichlet_optimize(graded, stat)
            if best_w:
                print(f"LOCK accuracy {best_acc:.1%} on {n_locks} LOCKs")
                optimized[stat] = {'weights': best_w, 'lock_accuracy': best_acc, 'n_locks': n_locks}
            else:
                print("insufficient LOCK props")

        if optimized:
            out = 'weight_optimizer_pit_results.json'
            with open(out, 'w') as f:
                json.dump(optimized, f, indent=2)
            print(f"\nOptimized weights saved to {out}")

            print("\nSuggested TypeScript weight constants:")
            for stat, data in optimized.items():
                w = data['weights']
                print(f"\nconst W_{stat.upper()} = {{")
                for k, v in w.items():
                    print(f"  {k}: {v:.2f},")
                print(f"}}  // LOCK {data['lock_accuracy']:.1%} on {data['n_locks']} props (PIT backtest)")

    print("\nDone.")

if __name__ == '__main__':
    main()
