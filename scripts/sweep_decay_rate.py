"""
T2: Decay Rate Sensitivity Sweep

Tests hit-rate decay values {0.88, 0.90, 0.93, 0.95, 0.97} per stat type
to find optimal exponential weighting for the last20HitRate factor.

Current default: 0.93 (game 10 gets ~48% weight)

Usage:
  python scripts/sweep_decay_rate.py [--stat points] [--days 120]

Requires: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_KEY in .env.local
"""

import os, sys, json, math
from pathlib import Path
from datetime import datetime, timedelta
import requests

# ── Load env ──────────────────────────────────────────────────────────────────
env_path = Path(__file__).parent.parent / '.env.local'
env = {}
if env_path.exists():
    for line in env_path.read_text().splitlines():
        if '=' in line and not line.startswith('#'):
            k, v = line.split('=', 1)
            env[k.strip()] = v.strip()

SUPABASE_URL = env.get('NEXT_PUBLIC_SUPABASE_URL', os.environ.get('NEXT_PUBLIC_SUPABASE_URL'))
SUPABASE_KEY = env.get('SUPABASE_SERVICE_KEY', os.environ.get('SUPABASE_SERVICE_KEY'))

if not SUPABASE_URL or not SUPABASE_KEY:
    print("ERROR: Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_KEY in .env.local")
    sys.exit(1)

HEADERS = {
    'apikey': SUPABASE_KEY,
    'Authorization': f'Bearer {SUPABASE_KEY}',
    'Content-Type': 'application/json',
}

# ── Supabase paginated fetch ─────────────────────────────────────────────────
def sb_get_all(table: str, select: str = '*', filters: str = '') -> list:
    rows = []
    offset = 0
    PAGE = 1000
    while True:
        url = f"{SUPABASE_URL}/rest/v1/{table}?select={select}&offset={offset}&limit={PAGE}"
        if filters:
            url += f"&{filters}"
        resp = requests.get(url, headers=HEADERS)
        resp.raise_for_status()
        page = resp.json()
        if not page:
            break
        rows.extend(page)
        if len(page) < PAGE:
            break
        offset += PAGE
    return rows

# ── Stat value getter ────────────────────────────────────────────────────────
def get_stat(log: dict, stat_type: str) -> float:
    mapping = {
        'points': 'points', 'rebounds': 'rebounds', 'assists': 'assists',
        'steals': 'steals', 'blocks': 'blocks', 'three_pointers': 'fg3m',
        'pra': None,
    }
    if stat_type == 'pra':
        return float(log.get('points', 0) or 0) + float(log.get('rebounds', 0) or 0) + float(log.get('assists', 0) or 0)
    col = mapping.get(stat_type, stat_type)
    return float(log.get(col, 0) or 0)

# ── Hit rate with configurable decay ─────────────────────────────────────────
def weighted_hit_rate(logs: list, line: float, stat_type: str, direction: str, decay: float) -> float | None:
    """Compute exponentially-weighted hit rate with given decay factor."""
    filtered = [g for g in logs if float(g.get('minutes', 0) or 0) >= 5]
    if len(filtered) < 3:
        return None

    weighted_hits = 0.0
    total_weight = 0.0
    for i, g in enumerate(filtered[:20]):  # L20
        w = decay ** i
        val = get_stat(g, stat_type)
        hit = (val > line) if direction == 'over' else (val < line)
        if hit:
            weighted_hits += w
        total_weight += w

    return weighted_hits / total_weight if total_weight > 0 else None

# ── Main sweep ───────────────────────────────────────────────────────────────
def main():
    import argparse
    parser = argparse.ArgumentParser(description='Decay rate sensitivity sweep')
    parser.add_argument('--stat', default=None, help='Stat type to sweep (default: all)')
    parser.add_argument('--days', type=int, default=120, help='Days of graded data to use')
    args = parser.parse_args()

    stat_filter = args.stat
    cutoff = (datetime.now() - timedelta(days=args.days)).strftime('%Y-%m-%d')

    print(f"Loading graded props since {cutoff}...")
    filters = f"result=in.(hit,miss)&game_date=gte.{cutoff}"
    if stat_filter:
        filters += f"&stat_type=eq.{stat_filter}"
    grades = sb_get_all('prop_grades', 'player_name,stat_type,line,direction,result,game_date,confidence_score', filters)
    print(f"  Loaded {len(grades)} graded props")

    print("Loading game logs...")
    logs = sb_get_all('player_game_logs', 'player_name,game_date,points,rebounds,assists,steals,blocks,fg3m,minutes')
    print(f"  Loaded {len(logs)} game logs")

    # Build logs-by-player map (sorted by date descending)
    logs_by_player: dict[str, list] = {}
    for log in logs:
        name = log['player_name']
        if name not in logs_by_player:
            logs_by_player[name] = []
        logs_by_player[name].append(log)
    for name in logs_by_player:
        logs_by_player[name].sort(key=lambda g: g['game_date'], reverse=True)

    # ── Sweep decay rates ────────────────────────────────────────────────────
    DECAY_VALUES = [0.88, 0.90, 0.93, 0.95, 0.97]
    stat_types = [stat_filter] if stat_filter else ['points', 'rebounds', 'assists', 'pra', 'steals', 'blocks', 'three_pointers']

    results = {}

    for stat in stat_types:
        stat_grades = [g for g in grades if g['stat_type'] == stat]
        if not stat_grades:
            continue

        print(f"\n{'='*60}")
        print(f"  {stat.upper()} — {len(stat_grades)} graded props")
        print(f"{'='*60}")
        print(f"  {'Decay':<8} {'Accurate':<10} {'Total':<8} {'HR Accuracy':<12}")
        print(f"  {'-'*40}")

        best_decay = None
        best_accuracy = 0.0

        for decay in DECAY_VALUES:
            correct = 0
            total = 0

            for grade in stat_grades:
                player = grade['player_name']
                game_date = grade['game_date']
                player_logs = logs_by_player.get(player, [])

                # Filter to logs BEFORE this game date
                prior_logs = [g for g in player_logs if g['game_date'] < game_date]
                if len(prior_logs) < 3:
                    continue

                hr = weighted_hit_rate(prior_logs, float(grade['line']), stat, grade['direction'], decay)
                if hr is None:
                    continue

                # Prediction: if hr > 0.50, predict hit; else miss
                predicted_hit = hr > 0.50
                actual_hit = grade['result'] == 'hit'

                if predicted_hit == actual_hit:
                    correct += 1
                total += 1

            accuracy = correct / total if total > 0 else 0
            print(f"  {decay:<8.2f} {correct:<10} {total:<8} {accuracy:<12.4f}")

            if accuracy > best_accuracy:
                best_accuracy = accuracy
                best_decay = decay

        results[stat] = {'best_decay': best_decay, 'accuracy': best_accuracy}
        print(f"  >>> Best decay for {stat}: {best_decay} ({best_accuracy:.4f})")

    # ── Summary ──────────────────────────────────────────────────────────────
    print(f"\n{'='*60}")
    print("  SUMMARY — Optimal Decay Rates")
    print(f"{'='*60}")
    for stat, r in results.items():
        current = "0.93 (current)"
        marker = " <<<" if r['best_decay'] != 0.93 else ""
        print(f"  {stat:<20} best={r['best_decay']:<6} accuracy={r['accuracy']:.4f}  {current}{marker}")

    # Save results
    out_path = Path(__file__).parent / 'decay_sweep_results.json'
    with open(out_path, 'w') as f:
        json.dump(results, f, indent=2)
    print(f"\nResults saved to {out_path}")


if __name__ == '__main__':
    main()
