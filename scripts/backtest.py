"""
Prizm Confidence Engine — Backtester v1
========================================
Walk-forward validation on historical game logs to find optimal factor weights.

Two modes:
  1. Synthetic lines (default): uses each player's rolling 20-game average as
     the prop line. Works with data already in Supabase — no extra API key needed.

  2. Real lines (--real-lines): fetches actual historical NBA player prop lines
     from The Odds API (the-odds-api.com). Requires THE_ODDS_API_KEY in .env.local
     and a paid plan ($20+/month). Data available from May 2023 onwards.

What it outputs:
  - Per-factor predictive accuracy (how often factor > 0.5 correctly called the outcome)
  - Logistic regression coefficients → recommended model weights
  - Overall model accuracy vs. naive baseline

Usage:
    pip install scikit-learn numpy requests
    python scripts/backtest.py
    python scripts/backtest.py --real-lines
    python scripts/backtest.py --stat points     # test a single stat
    python scripts/backtest.py --min-games 15    # require more prior games
"""

import os, sys, re, argparse, json
from datetime import datetime, timedelta
from collections import defaultdict

# ── Load .env.local ─────────────────────────────────────────────────────────
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

SUPABASE_URL = os.environ.get('NEXT_PUBLIC_SUPABASE_URL') or env.get('NEXT_PUBLIC_SUPABASE_URL', '')
SUPABASE_KEY = os.environ.get('SUPABASE_SERVICE_KEY') or env.get('SUPABASE_SERVICE_KEY', '')
THE_ODDS_API_KEY = os.environ.get('THE_ODDS_API_KEY') or env.get('THE_ODDS_API_KEY', '')

if not SUPABASE_URL or not SUPABASE_KEY:
    print("ERROR: Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_KEY in .env.local")
    sys.exit(1)

SB_HEADERS = {
    'apikey': SUPABASE_KEY,
    'Authorization': f'Bearer {SUPABASE_KEY}',
}

# ── Supabase helpers ─────────────────────────────────────────────────────────
def sb_get_all(table, params=''):
    rows = []
    offset = 0
    while True:
        sep = '&' if params else ''
        url = f'{SUPABASE_URL}/rest/v1/{table}?{params}{sep}limit=1000&offset={offset}'
        r = requests.get(url, headers=SB_HEADERS, timeout=30)
        r.raise_for_status()
        batch = r.json()
        if not batch:
            break
        rows.extend(batch)
        if len(batch) < 1000:
            break
        offset += 1000
    return rows

# ── Stat helpers ─────────────────────────────────────────────────────────────
STAT_TYPES = ['points', 'rebounds', 'assists', 'steals', 'blocks', 'three_pointers']

def get_stat(log, stat_type):
    return {
        'points':         float(log.get('points', 0) or 0),
        'rebounds':       float(log.get('rebounds', 0) or 0),
        'assists':        float(log.get('assists', 0) or 0),
        'steals':         float(log.get('steals', 0) or 0),
        'blocks':         float(log.get('blocks', 0) or 0),
        'three_pointers': float(log.get('fg3m', 0) or 0),
        'pra':            float(log.get('pra', 0) or 0),
    }.get(stat_type, 0.0)

def extract_opponent(matchup):
    """'LAL vs. DEN' → 'DEN',  'LAL @ MIL' → 'MIL'"""
    parts = re.split(r'\s+vs\.\s+|\s+@\s+', matchup)
    return parts[1].strip().upper() if len(parts) >= 2 else None

def extract_player_team(matchup):
    """'LAL vs. DEN' → 'LAL'"""
    parts = re.split(r'\s+vs\.\s+|\s+@\s+', matchup)
    return parts[0].strip().upper() if parts else None

# ── Factor computation ────────────────────────────────────────────────────────
def clamp(x, lo=0.05, hi=0.95):
    return min(hi, max(lo, x))

def factor_last_n_hitrate(prior, stat_type, line, direction, n):
    """Hit rate over last n games vs the given line."""
    sl = prior[:n]
    if len(sl) < 3:
        return None
    hits = sum(1 for g in sl if (get_stat(g, stat_type) > line if direction == 'over' else get_stat(g, stat_type) < line))
    return hits / len(sl)

def factor_cushion(prior, stat_type, line, direction):
    """Season average distance from the line (S-curve mapped to [0.05, 0.95])."""
    vals = [get_stat(g, stat_type) for g in prior]
    vals = [v for v in vals if v >= 0]
    if len(vals) < 5:
        return 0.5
    avg = sum(vals) / len(vals)
    pct = (avg - line) / max(line, 1)
    raw = clamp(pct / 0.60 + 0.50)
    return raw if direction == 'over' else 1 - raw

def factor_trend(prior, stat_type, direction):
    """L5 avg vs L20 avg momentum."""
    l5  = [get_stat(g, stat_type) for g in prior[:5]]
    l20 = [get_stat(g, stat_type) for g in prior[:20]]
    if len(l5) < 3 or len(l20) < 8:
        return 0.5
    avg5  = sum(l5)  / len(l5)
    avg20 = sum(l20) / len(l20)
    if avg20 == 0:
        return 0.5
    trend_pct = (avg5 - avg20) / avg20
    raw = clamp(trend_pct / 0.40 + 0.50)
    return raw if direction == 'over' else 1 - raw

def factor_consistency(prior, stat_type):
    """Low coefficient of variation → more predictable → higher score."""
    vals = [get_stat(g, stat_type) for g in prior[:20]]
    vals = [v for v in vals if v >= 0]
    if len(vals) < 5:
        return 0.5
    mean = sum(vals) / len(vals)
    if mean == 0:
        return 0.3
    variance = sum((v - mean) ** 2 for v in vals) / len(vals)
    cv = (variance ** 0.5) / mean
    if cv < 0.20: return 1.0
    if cv < 0.35: return 0.8
    if cv < 0.50: return 0.6
    if cv < 0.70: return 0.4
    return 0.2

def factor_matchup(def_stats_map, opp_abbr, stat_type, direction):
    """Opponent's team defensive rank for this stat."""
    if not opp_abbr or opp_abbr not in def_stats_map:
        return 0.5
    rank_key = {
        'points': 'pts_rank', 'rebounds': 'reb_rank', 'assists': 'ast_rank',
        'steals': 'stl_rank', 'blocks': 'blk_rank',
        'three_pointers': 'fg3m_rank', 'pra': 'pts_rank'
    }.get(stat_type, 'pts_rank')
    rank = def_stats_map[opp_abbr].get(rank_key, 15)
    raw = (rank - 1) / 29
    return raw if direction == 'over' else 1 - raw

def factor_vs_opponent(prior, stat_type, line, direction, opp_abbr):
    """Bayesian-blended hit rate in historical games vs this specific team."""
    if not opp_abbr:
        return 0.5, 0
    vs_logs = [g for g in prior if extract_opponent(g.get('matchup', '')) == opp_abbr]
    n = len(vs_logs)
    if n < 2:
        return 0.5, n
    hits = sum(1 for g in vs_logs if (get_stat(g, stat_type) > line if direction == 'over' else get_stat(g, stat_type) < line))
    raw_rate = hits / n
    # Blend toward 0.5 based on sample size
    weight = min(0.80, 0.15 + n * 0.13)
    return raw_rate * weight + 0.5 * (1 - weight), n

def factor_home_away(prior, stat_type, line, direction, is_home):
    """Hit rate in home games vs away games (split matching tonight's venue)."""
    filtered = [g for g in prior if g.get('is_home') == is_home]
    if len(filtered) < 5:
        return 0.5
    hits = sum(1 for g in filtered if (get_stat(g, stat_type) > line if direction == 'over' else get_stat(g, stat_type) < line))
    return hits / len(filtered)

def factor_blowout(spread):
    """
    Blowout risk based on point spread. Large spreads mean starters may sit
    early in the 4th quarter, reducing counting stat opportunities for both teams.

    In the backtester we don't have historical spread data, so this defaults
    to 0.5 (neutral). In production the enrich route fetches live spreads from
    the ESPN scoreboard API. The backtester still includes this factor column
    so it appears in the weight comparison output.
    """
    if spread is None:
        return 0.5
    if spread <= 3:  return 0.50
    if spread <= 6:  return 0.47
    if spread <= 9:  return 0.44
    if spread <= 12: return 0.41
    return 0.37

def factor_news_injury(player_status, injured_teammates_boost):
    """
    Real-time injury/news context. Cannot be backtested historically — we don't
    have injury report snapshots for past games. Returns 0.5 (neutral) in the
    backtester. In production the enrich route fetches the ESPN injury API and
    computes boosts from injured teammates and penalties for a questionable player.
    """
    if player_status == 'out':          return 0.05
    if player_status == 'doubtful':     return 0.25
    if player_status == 'questionable': return 0.42
    return min(0.95, 0.50 + injured_teammates_boost)

# ── Build test cases ──────────────────────────────────────────────────────────
def build_test_cases_synthetic(logs_by_player, def_stats_map, stat_types, min_prior_games=10):
    """
    For each player × game × stat, generate a test case using rolling average as line.
    Returns list of dicts: {features: [...], label: 1/0, meta: {...}}
    """
    cases = []
    for player, logs in logs_by_player.items():
        # Sort oldest → newest so we can do walk-forward
        sorted_logs = sorted(logs, key=lambda g: g['game_date'])

        for i, test_game in enumerate(sorted_logs):
            # Use all games BEFORE this one as "history" (newest first)
            prior = list(reversed(sorted_logs[:i]))
            if len(prior) < min_prior_games:
                continue

            opp_abbr = extract_opponent(test_game.get('matchup', ''))
            is_home  = test_game.get('is_home', False)

            for stat in stat_types:
                actual = get_stat(test_game, stat)

                # Skip games where player didn't play (0 minutes, all zeros)
                mins = float(test_game.get('minutes', 0) or 0)
                if mins < 5:
                    continue

                # Synthetic line = rolling 20-game average from prior data
                prior_vals = [get_stat(g, stat) for g in prior[:20]]
                prior_vals = [v for v in prior_vals if v >= 0]
                if len(prior_vals) < 5:
                    continue
                line = sum(prior_vals) / len(prior_vals)

                # Skip stats where the line is near zero (e.g., non-scorers for blocks)
                if line < 0.5 and stat in ('blocks', 'steals', 'three_pointers'):
                    continue
                if line < 1.0 and stat in ('rebounds',):
                    continue

                # Test direction = 'over' (will player exceed their own average?)
                direction = 'over'
                label = 1 if actual > line else 0

                # Compute all factors
                f_l10     = factor_last_n_hitrate(prior, stat, line, direction, 10) or 0.5
                f_l20     = factor_last_n_hitrate(prior, stat, line, direction, 20) or 0.5
                f_cushion = factor_cushion(prior, stat, line, direction)
                f_trend   = factor_trend(prior, stat, direction)
                f_consist = factor_consistency(prior, stat)
                f_matchup = factor_matchup(def_stats_map, opp_abbr, stat, direction)
                f_vs_opp, vs_n = factor_vs_opponent(prior, stat, line, direction, opp_abbr)
                f_home    = factor_home_away(prior, stat, line, direction, is_home)
                # blowout and newsInjury: 0.5 neutral (no historical spread/injury data)
                f_blowout     = factor_blowout(None)
                f_news_injury = factor_news_injury(None, 0.0)

                cases.append({
                    'features': [f_l10, f_matchup, f_cushion, f_vs_opp, f_home, f_trend, f_l20, f_consist, f_blowout, f_news_injury],
                    'label':    label,
                    'meta': {
                        'player': player,
                        'stat':   stat,
                        'line':   round(line, 2),
                        'actual': actual,
                        'date':   test_game['game_date'],
                        'opp':    opp_abbr,
                        'vs_n':   vs_n,
                    }
                })

    return cases


def build_test_cases_real_lines(real_props, logs_by_player, def_stats_map):
    """
    Build test cases using actual historical prop lines from The Odds API.
    real_props: list of {player_name, stat_type, line, direction, game_date, home_team, away_team}
    """
    cases = []
    for prop in real_props:
        player    = prop['player_name']
        stat      = prop['stat_type']
        line      = prop['line']
        direction = prop['direction']
        game_date = prop['game_date']
        home_team = prop.get('home_team', '')
        away_team = prop.get('away_team', '')

        if player not in logs_by_player:
            continue

        all_logs = sorted(logs_by_player[player], key=lambda g: g['game_date'])

        # Find the actual game log entry for this date
        target = next((g for g in all_logs if g['game_date'] == game_date), None)
        if not target:
            continue

        mins = float(target.get('minutes', 0) or 0)
        if mins < 5:
            continue

        actual = get_stat(target, stat)
        label  = 1 if (actual > line if direction == 'over' else actual < line) else 0

        # Prior logs = all games strictly before this date
        prior = list(reversed([g for g in all_logs if g['game_date'] < game_date]))
        if len(prior) < 10:
            continue

        opp_abbr = extract_opponent(target.get('matchup', ''))
        is_home  = target.get('is_home', False)

        f_l10     = factor_last_n_hitrate(prior, stat, line, direction, 10) or 0.5
        f_l20     = factor_last_n_hitrate(prior, stat, line, direction, 20) or 0.5
        f_cushion = factor_cushion(prior, stat, line, direction)
        f_trend   = factor_trend(prior, stat, direction)
        f_consist = factor_consistency(prior, stat)
        f_matchup = factor_matchup(def_stats_map, opp_abbr, stat, direction)
        f_vs_opp, vs_n = factor_vs_opponent(prior, stat, line, direction, opp_abbr)
        f_home    = factor_home_away(prior, stat, line, direction, is_home)
        f_blowout     = factor_blowout(None)
        f_news_injury = factor_news_injury(None, 0.0)

        cases.append({
            'features': [f_l10, f_matchup, f_cushion, f_vs_opp, f_home, f_trend, f_l20, f_consist, f_blowout, f_news_injury],
            'label':    label,
            'meta': {
                'player': player,
                'stat':   stat,
                'line':   line,
                'actual': actual,
                'date':   game_date,
                'opp':    opp_abbr,
                'vs_n':   vs_n,
            }
        })

    return cases


# ── Analysis ──────────────────────────────────────────────────────────────────
FACTOR_NAMES = [
    'last10HitRate',
    'matchupEdge',
    'seasonCushion',
    'vsOpponent',
    'homeAway',
    'trend',
    'last20HitRate',
    'consistency',
    # blowout and newsInjury are fixed at 0.5 in the backtester (no historical data).
    # They appear here so the comparison table includes them and logistic regression
    # can confirm they carry ~0 predictive weight in synthetic mode (expected).
    'blowout',
    'newsInjury',
]

def analyze(cases, label=''):
    import numpy as np

    if not cases:
        print("No test cases to analyze.")
        return

    X = np.array([c['features'] for c in cases])
    y = np.array([c['label'] for c in cases])

    print(f"\n{'='*60}")
    print(f"  {label}  ({len(cases):,} test cases)")
    print(f"{'='*60}")
    print(f"  Baseline (always predict majority): {max(y.mean(), 1-y.mean()):.1%}")

    # ── Per-factor individual accuracy ────────────────────────────────────────
    print(f"\n  Per-factor accuracy (threshold = 0.5):")
    print(f"  {'Factor':<20} {'Accuracy':>9} {'Avg Score':>10} {'Samples':>8}")
    print(f"  {'-'*50}")
    for i, name in enumerate(FACTOR_NAMES):
        col = X[:, i]
        preds = (col > 0.5).astype(int)
        acc = (preds == y).mean()
        print(f"  {name:<20} {acc:>8.1%}  {col.mean():>9.3f}  {len(col):>8,}")

    # ── Try logistic regression for optimal weights ────────────────────────────
    try:
        from sklearn.linear_model import LogisticRegression
        from sklearn.preprocessing import StandardScaler
        from sklearn.model_selection import StratifiedKFold, cross_val_score
        from sklearn.metrics import accuracy_score

        scaler = StandardScaler()
        X_scaled = scaler.fit_transform(X)

        # Cross-validated accuracy
        lr = LogisticRegression(max_iter=500, C=1.0, random_state=42)
        cv_scores = cross_val_score(lr, X_scaled, y, cv=5, scoring='accuracy')

        # Fit on full data for weight extraction
        lr.fit(X_scaled, y)
        coefs = lr.coef_[0]

        # Normalize positive coefficients to weights (negative = factor hurts)
        pos_coefs = [max(c, 0) for c in coefs]
        total = sum(pos_coefs) or 1
        weights = [round(c / total, 3) for c in pos_coefs]

        print(f"\n  Logistic Regression (5-fold CV accuracy): {cv_scores.mean():.1%} ± {cv_scores.std():.1%}")
        print(f"\n  Recommended weights (from logistic regression):")
        print(f"  {'Factor':<20} {'Raw Coef':>10} {'Weight':>8}")
        print(f"  {'-'*42}")

        for name, coef, w in sorted(zip(FACTOR_NAMES, coefs, weights), key=lambda x: -x[1]):
            direction_marker = '+' if coef > 0 else '-'
            print(f"  {name:<20} {coef:>+9.4f} {direction_marker}  {w:>6.1%}")

        # Current weights for comparison (v3 — includes blowout + newsInjury)
        current_weights = {
            'last10HitRate': 0.20,
            'matchupEdge':   0.16,
            'seasonCushion': 0.13,
            'vsOpponent':    0.12,
            'homeAway':      0.09,
            'trend':         0.09,
            'last20HitRate': 0.06,
            'consistency':   0.02,
            'bookOdds':      0.01,
            'blowout':       0.07,   # real-time only, 0.5 neutral in backtest
            'newsInjury':    0.05,   # real-time only, 0.5 neutral in backtest
        }

        print(f"\n  Comparison — current vs. data-driven weights:")
        print(f"  {'Factor':<20} {'Current':>9} {'Suggested':>10} {'Delta':>8}")
        print(f"  {'-'*52}")
        for name, w in zip(FACTOR_NAMES, weights):
            curr = current_weights.get(name, 0)
            delta = w - curr
            marker = '^' if delta > 0.02 else ('v' if delta < -0.02 else ' ')
            print(f"  {name:<20} {curr:>8.1%}  {w:>9.1%}  {delta:>+7.1%} {marker}")

        print(f"\n  Model accuracy with data-driven weights:")
        print(f"    Cross-validated: {cv_scores.mean():.1%}")

        # Save suggested weights to JSON
        output = {
            'generated_at': datetime.utcnow().isoformat() + 'Z',
            'mode': label,
            'n_test_cases': len(cases),
            'cv_accuracy': round(float(cv_scores.mean()), 4),
            'baseline_accuracy': round(float(max(y.mean(), 1-y.mean())), 4),
            'suggested_weights': {
                name: round(w, 4)
                for name, w in zip(FACTOR_NAMES, weights)
            },
            'current_weights': current_weights,
        }
        out_path = os.path.join(os.path.dirname(__file__), '..', 'backtest_results.json')
        with open(out_path, 'w') as f:
            json.dump(output, f, indent=2)
        print(f"\n  Results saved -> backtest_results.json")

    except ImportError:
        print("\n  [!] scikit-learn not installed — skipping logistic regression.")
        print("      Install with: pip install scikit-learn numpy")

    # ── Stat-by-stat breakdown ────────────────────────────────────────────────
    print(f"\n  Test cases by stat type:")
    stat_counts = defaultdict(int)
    for c in cases:
        stat_counts[c['meta']['stat']] += 1
    for stat, count in sorted(stat_counts.items(), key=lambda x: -x[1]):
        print(f"    {stat:<18} {count:>6,} cases")


# ── Real lines: fetch from The Odds API ──────────────────────────────────────
TEAM_NAME_TO_ABBR = {
    'Atlanta Hawks': 'ATL', 'Boston Celtics': 'BOS', 'Brooklyn Nets': 'BKN',
    'Charlotte Hornets': 'CHA', 'Chicago Bulls': 'CHI', 'Cleveland Cavaliers': 'CLE',
    'Dallas Mavericks': 'DAL', 'Denver Nuggets': 'DEN', 'Detroit Pistons': 'DET',
    'Golden State Warriors': 'GSW', 'Houston Rockets': 'HOU', 'Indiana Pacers': 'IND',
    'Los Angeles Clippers': 'LAC', 'Los Angeles Lakers': 'LAL', 'Memphis Grizzlies': 'MEM',
    'Miami Heat': 'MIA', 'Milwaukee Bucks': 'MIL', 'Minnesota Timberwolves': 'MIN',
    'New Orleans Pelicans': 'NOP', 'New York Knicks': 'NYK', 'Oklahoma City Thunder': 'OKC',
    'Orlando Magic': 'ORL', 'Philadelphia 76ers': 'PHI', 'Phoenix Suns': 'PHX',
    'Portland Trail Blazers': 'POR', 'Sacramento Kings': 'SAC', 'San Antonio Spurs': 'SAS',
    'Toronto Raptors': 'TOR', 'Utah Jazz': 'UTA', 'Washington Wizards': 'WAS',
}

# The Odds API stat market names → our stat_type
ODDS_MARKET_MAP = {
    'player_points':      'points',
    'player_rebounds':    'rebounds',
    'player_assists':     'assists',
    'player_steals':      'steals',
    'player_blocks':      'blocks',
    'player_threes':      'three_pointers',
}

def fetch_real_lines(start_date, end_date, logs_by_player):
    """
    Fetch historical NBA player prop lines from The Odds API for a date range.
    Returns list of prop dicts ready for build_test_cases_real_lines().
    """
    if not THE_ODDS_API_KEY:
        print("ERROR: THE_ODDS_API_KEY not found in .env.local")
        print("  Sign up at https://the-odds-api.com (plans from $20/month)")
        print("  Add THE_ODDS_API_KEY=your_key to .env.local then re-run with --real-lines")
        return []

    print(f"\n[Real Lines] Fetching historical props from The Odds API...")
    print(f"  Date range: {start_date} → {end_date}")
    print(f"  Note: this uses API credits. Each event fetch costs ~10 credits.")

    base = 'https://api.the-odds-api.com/v4'
    props = []

    # Build list of dates to check (each game day)
    current = datetime.strptime(start_date, '%Y-%m-%d')
    end     = datetime.strptime(end_date, '%Y-%m-%d')
    dates   = []
    while current <= end:
        dates.append(current)
        current += timedelta(days=1)

    for dt in dates:
        iso = dt.strftime('%Y-%m-%dT18:00:00Z')  # fetch at 6pm UTC (before most games)

        # 1. Get historical events snapshot for this date
        events_url = (
            f"{base}/historical/sports/basketball_nba/events"
            f"?apiKey={THE_ODDS_API_KEY}&date={iso}"
        )
        try:
            r = requests.get(events_url, timeout=20)
            if r.status_code == 401:
                print(f"  ERROR: Invalid API key or plan does not support historical data")
                return []
            if not r.ok:
                print(f"  Warning: events request failed for {dt.date()} — {r.status_code}")
                continue
            data = r.json()
            events = data.get('data', [])
            remaining = r.headers.get('x-requests-remaining', '?')
            print(f"  {dt.date()}: {len(events)} events  (credits remaining: {remaining})")
        except Exception as e:
            print(f"  Error fetching events for {dt.date()}: {e}")
            continue

        for event in events:
            event_id  = event['id']
            home_team = event.get('home_team', '')
            away_team = event.get('away_team', '')
            home_abbr = TEAM_NAME_TO_ABBR.get(home_team, '')
            away_abbr = TEAM_NAME_TO_ABBR.get(away_team, '')

            for market, stat_type in ODDS_MARKET_MAP.items():
                odds_url = (
                    f"{base}/historical/sports/basketball_nba/events/{event_id}/odds"
                    f"?apiKey={THE_ODDS_API_KEY}"
                    f"&date={iso}"
                    f"&markets={market}"
                    f"&bookmakers=draftkings"
                    f"&oddsFormat=american"
                )
                try:
                    r2 = requests.get(odds_url, timeout=20)
                    if not r2.ok:
                        continue
                    ev_data = r2.json().get('data', {})
                    bookmakers = ev_data.get('bookmakers', [])
                except Exception:
                    continue

                for bm in bookmakers:
                    for mkt in bm.get('markets', []):
                        for outcome in mkt.get('outcomes', []):
                            player_name = outcome.get('description', '').strip()
                            direction   = outcome.get('name', '').lower()  # 'over' or 'under'
                            line        = outcome.get('point')
                            if not player_name or not line or direction not in ('over', 'under'):
                                continue
                            if player_name not in logs_by_player:
                                continue
                            props.append({
                                'player_name': player_name,
                                'stat_type':   stat_type,
                                'line':        float(line),
                                'direction':   direction,
                                'game_date':   dt.strftime('%Y-%m-%d'),
                                'home_team':   home_abbr,
                                'away_team':   away_abbr,
                            })

    print(f"  Total real prop lines fetched: {len(props):,}")
    return props


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description='Prizm Confidence Engine Backtester')
    parser.add_argument('--real-lines',  action='store_true', help='Use real historical lines from The Odds API')
    parser.add_argument('--stat',        default=None,        help='Test a single stat type (e.g. points)')
    parser.add_argument('--min-games',   type=int, default=10, help='Min prior games required (default: 10)')
    parser.add_argument('--start-date',  default=None,        help='Start date for real lines YYYY-MM-DD')
    parser.add_argument('--end-date',    default=None,        help='End date for real lines YYYY-MM-DD')
    args = parser.parse_args()

    stat_types = [args.stat] if args.stat else STAT_TYPES

    # ── Load game logs ────────────────────────────────────────────────────────
    print("\n[1/3] Loading game logs from Supabase...")
    raw_logs = sb_get_all('player_game_logs', 'order=game_date.desc')
    print(f"      {len(raw_logs):,} game log rows for {len(set(g['player_name'] for g in raw_logs))} players")

    # Group by player
    logs_by_player = defaultdict(list)
    for log in raw_logs:
        if log.get('player_name') and log.get('game_date'):
            logs_by_player[log['player_name']].append(log)

    # ── Load team defense stats ───────────────────────────────────────────────
    print("\n[2/3] Loading team defense stats...")
    def_rows = sb_get_all('team_defense_stats')
    def_stats_map = {row['team_abbreviation']: row for row in def_rows}
    print(f"      {len(def_stats_map)} teams loaded")

    # ── Build test cases ──────────────────────────────────────────────────────
    print("\n[3/3] Building test cases...")

    if args.real_lines:
        start = args.start_date or (datetime.utcnow() - timedelta(days=365)).strftime('%Y-%m-%d')
        end   = args.end_date   or (datetime.utcnow() - timedelta(days=1)).strftime('%Y-%m-%d')
        real_props = fetch_real_lines(start, end, logs_by_player)
        if not real_props:
            print("No real prop lines fetched — falling back to synthetic lines.")
            cases = build_test_cases_synthetic(
                logs_by_player, def_stats_map, stat_types, args.min_games
            )
            label = 'Synthetic Lines (rolling average)'
        else:
            cases = build_test_cases_real_lines(real_props, logs_by_player, def_stats_map)
            label = f'Real Lines from The Odds API ({start} → {end})'
    else:
        cases = build_test_cases_synthetic(
            logs_by_player, def_stats_map, stat_types, args.min_games
        )
        label = f'Synthetic Lines (rolling avg as proxy, {args.min_games}+ prior games required)'

    print(f"      Generated {len(cases):,} test cases")

    if len(cases) < 50:
        print(f"\n  WARNING: Only {len(cases)} test cases — results may not be reliable.")
        print("  Try running fetch_nba_stats.py first to populate more game log data.")
        if len(cases) == 0:
            print("  No cases to analyze. Exiting.")
            return

    # ── Analyze ───────────────────────────────────────────────────────────────
    analyze(cases, label=label)

    # ── Per-stat breakdown ────────────────────────────────────────────────────
    if not args.stat and len(cases) > 200:
        print(f"\n{'='*60}")
        print("  Per-stat model accuracy (logistic regression):")
        try:
            import numpy as np
            from sklearn.linear_model import LogisticRegression
            from sklearn.preprocessing import StandardScaler
            from sklearn.model_selection import cross_val_score

            print(f"  {'Stat':<20} {'CV Accuracy':>12} {'N Cases':>9}")
            print(f"  {'-'*44}")
            for stat in STAT_TYPES:
                stat_cases = [c for c in cases if c['meta']['stat'] == stat]
                if len(stat_cases) < 30:
                    continue
                X_s = np.array([c['features'] for c in stat_cases])
                y_s = np.array([c['label'] for c in stat_cases])
                scaler = StandardScaler()
                X_sc = scaler.fit_transform(X_s)
                lr = LogisticRegression(max_iter=500, C=1.0, random_state=42)
                scores = cross_val_score(lr, X_sc, y_s, cv=min(5, len(stat_cases)//10), scoring='accuracy')
                print(f"  {stat:<20} {scores.mean():>11.1%}  {len(stat_cases):>8,}")
        except ImportError:
            pass

    print(f"\nDone! Check backtest_results.json for the suggested weights.\n")


if __name__ == '__main__':
    main()
