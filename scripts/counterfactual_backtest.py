"""
Counterfactual Backtest
=======================
Re-tiers every prop_grades row using the score deltas from recent model
changes (without recomputing factors from raw data). Compares OLD vs NEW
LOCK/PLAY/LEAN/FADE distributions and hit rates.

Changes simulated:
  1. Over-bias gate flip — old gate (overRate > 0.55) never fired in prod.
     New gate (< 0.50) always fires. So the full OVER_BIAS magnitude is
     now applied to over picks.
  2. Under-bias addition — new factor, full magnitude on under picks.
  3. player_line_bias multiplier 10 -> 22, cap 5 -> 10.

Limitations:
  - player_line_bias values are current (not point-in-time at grade date).
    OK as approximation since bias is a slow-moving signal.
  - Doesn't simulate consistency factor (needs per-prop game logs).
  - Doesn't simulate opponent_leak retune (needs opponent lookup).
  - Tier thresholds held at v11.1 values to isolate the bias impact.
"""

import os, json
from collections import defaultdict
import requests

env = {}
with open(os.path.join(os.path.dirname(__file__), '..', '.env.local'), encoding='utf-8') as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            env[k.strip()] = v.strip().strip('"').strip("'")

SB_URL = env['NEXT_PUBLIC_SUPABASE_URL']
SB_KEY = env['SUPABASE_SERVICE_KEY']
HDR = {'apikey': SB_KEY, 'Authorization': f'Bearer {SB_KEY}'}

OVER_BIAS = {
    'points': -3, 'rebounds': -4, 'assists': -4, 'pra': -4,
    'steals': -10, 'blocks': -8, 'three_pointers': -7,
}
UNDER_BIAS = {
    'blocks': 8, 'steals': 6, 'assists': 4, 'pra': 3,
    'rebounds': 3, 'points': 2, 'three_pointers': 2,
}
LOCK_T = {'points': 74, 'rebounds': 74, 'assists': 78, 'pra': 78,
          'steals': 78, 'blocks': 78, 'three_pointers': 76}
PLAY_T = {'points': 70, 'rebounds': 72, 'assists': 72, 'pra': 76,
          'steals': 72, 'blocks': 74, 'three_pointers': 70}


def tier_for(score, stat):
    if score >= LOCK_T.get(stat, 74):  return 'LOCK'
    if score >= PLAY_T.get(stat, 68):  return 'PLAY'
    if score >= 50:                     return 'LEAN'
    return 'FADE'


def fetch_all(table, select='*'):
    rows, off = [], 0
    while True:
        r = requests.get(
            f'{SB_URL}/rest/v1/{table}?select={select}&limit=1000&offset={off}',
            headers=HDR, timeout=60,
        )
        r.raise_for_status()
        page = r.json()
        rows.extend(page)
        if len(page) < 1000:
            break
        off += 1000
    return rows


print('[1/4] Loading prop_grades...')
grades = fetch_all('prop_grades', 'player_name,stat_type,direction,confidence_score,hit')
grades = [g for g in grades if g.get('hit') is not None and g.get('confidence_score') is not None]
print(f'  {len(grades):,} graded props')

print('[2/4] Loading player_line_bias...')
bias_rows = fetch_all('player_line_bias', 'player_name,stat_type,hit_rate,sample_count')
bias_map = {}
for r in bias_rows:
    if r.get('sample_count', 0) >= 6:
        bias_map[(r['player_name'], r['stat_type'])] = r
print(f'  {len(bias_map):,} qualifying bias rows')


def player_bias_adj(player, stat, direction, mult, cap):
    b = bias_map.get((player, stat))
    if not b:
        return 0
    cs = min(b['sample_count'] / 20, 1.0)
    raw = (b['hit_rate'] - 0.5) * cs * mult
    adj = max(-cap, min(cap, raw))
    return adj if direction == 'over' else -adj


print('[3/4] Re-tiering all props with new model...')
old_tiers = defaultdict(lambda: {'n': 0, 'hits': 0})
new_tiers = defaultdict(lambda: {'n': 0, 'hits': 0})
tier_movement = defaultdict(int)

for g in grades:
    stat = g['stat_type']
    direction = g['direction']
    old_score = g['confidence_score']
    hit = g['hit']

    old_tier = tier_for(old_score, stat)
    old_tiers[old_tier]['n'] += 1
    if hit:
        old_tiers[old_tier]['hits'] += 1

    delta = 0
    if direction == 'over':
        delta += OVER_BIAS.get(stat, 0)
    if direction == 'under':
        delta += UNDER_BIAS.get(stat, 0)
    new_pb = player_bias_adj(g['player_name'], stat, direction, 22, 10)
    old_pb = player_bias_adj(g['player_name'], stat, direction, 10, 5)
    delta += (new_pb - old_pb)

    new_score = old_score + delta
    new_tier = tier_for(new_score, stat)
    new_tiers[new_tier]['n'] += 1
    if hit:
        new_tiers[new_tier]['hits'] += 1

    if old_tier != new_tier:
        tier_movement[(old_tier, new_tier)] += 1


def hr(t):
    return (t['hits'] / t['n'] * 100) if t['n'] else 0


print('[4/4] Done\n')
print('=' * 72)
print('TIER DISTRIBUTION + HIT RATES: OLD MODEL vs NEW MODEL')
print('=' * 72)
print(f'  {"tier":<6} {"OLD n":>9} {"OLD hr":>9} {"NEW n":>9} {"NEW hr":>9} {"d_n":>8} {"d_hr":>9}')
print('  ' + '-' * 64)
for t in ['LOCK', 'PLAY', 'LEAN', 'FADE']:
    o = old_tiers[t]
    n = new_tiers[t]
    dn = n['n'] - o['n']
    dh = hr(n) - hr(o)
    print(f'  {t:<6} {o["n"]:>9,} {hr(o):>8.1f}% {n["n"]:>9,} {hr(n):>8.1f}% {dn:>+8,} {dh:>+8.1f}')

# Combined LOCK+PLAY hit rate (the headline)
old_hp = {'n': old_tiers['LOCK']['n'] + old_tiers['PLAY']['n'],
          'hits': old_tiers['LOCK']['hits'] + old_tiers['PLAY']['hits']}
new_hp = {'n': new_tiers['LOCK']['n'] + new_tiers['PLAY']['n'],
          'hits': new_tiers['LOCK']['hits'] + new_tiers['PLAY']['hits']}
print()
print(f'  LOCK+PLAY: OLD n={old_hp["n"]:,} hr={hr(old_hp):.1f}%   '
      f'NEW n={new_hp["n"]:,} hr={hr(new_hp):.1f}%   '
      f'd={hr(new_hp)-hr(old_hp):+.1f}pt')

print()
print('TIER MOVEMENT (count >= 10):')
moves = sorted(tier_movement.items(), key=lambda x: -x[1])
for (a, b), c in moves:
    if a == b or c < 10:
        continue
    print(f'  {a:<5} -> {b:<5}: {c:>6,} props')

# Sensitivity: which change drives the biggest effect?
print()
print('=' * 72)
print('SENSITIVITY: each change in isolation')
print('=' * 72)
tests = [
    ('baseline (no changes)',         {'ob': False, 'ub': False, 'pb_new': False}),
    ('+ over-bias gate fix only',     {'ob': True,  'ub': False, 'pb_new': False}),
    ('+ under-bias only',             {'ob': False, 'ub': True,  'pb_new': False}),
    ('+ player_bias mult only',       {'ob': False, 'ub': False, 'pb_new': True}),
    ('over-bias + under-bias',        {'ob': True,  'ub': True,  'pb_new': False}),
    ('all three combined',            {'ob': True,  'ub': True,  'pb_new': True}),
]
for label, cfg in tests:
    lock_n = lock_h = play_n = play_h = 0
    for g in grades:
        stat = g['stat_type']
        direction = g['direction']
        score = g['confidence_score']
        if cfg['ob'] and direction == 'over':
            score += OVER_BIAS.get(stat, 0)
        if cfg['ub'] and direction == 'under':
            score += UNDER_BIAS.get(stat, 0)
        if cfg['pb_new']:
            new_pb = player_bias_adj(g['player_name'], stat, direction, 22, 10)
            old_pb = player_bias_adj(g['player_name'], stat, direction, 10, 5)
            score += (new_pb - old_pb)
        t = tier_for(score, stat)
        if t == 'LOCK':
            lock_n += 1
            if g['hit']: lock_h += 1
        elif t == 'PLAY':
            play_n += 1
            if g['hit']: play_h += 1
    lock_hr = (lock_h / lock_n * 100) if lock_n else 0
    play_hr = (play_h / play_n * 100) if play_n else 0
    print(f'  {label:<32}  LOCK n={lock_n:>4} hr={lock_hr:>5.1f}%   PLAY n={play_n:>5} hr={play_hr:>5.1f}%')
