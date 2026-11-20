# Calibration-Honest Tiers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make LOCK/PLAY tiers gate on calibration-derived raw-score thresholds (so a tier means a target calibrated hit-rate), remove the sub-vig LEAN tier, and unify the two labelers — without any Supabase DDL or data loss.

**Architecture:** `build_calibration.py` derives per-stat LOCK/PLAY raw thresholds from its isotonic curves (lowest raw score whose calibrated hit-rate clears a target) and writes them into `calibration-table.json`. `getLabel` reads those (falling back to config/defaults), gating LOCK ≥60% / PLAY ≥55% calibrated, FADE below. LEAN is forward-only-deprecated (kept as a legacy text/type value; never emitted). The alt-line labeler is deleted and routed through `getLabel`.

**Tech Stack:** Python 3.14 (`python3`, scikit-learn isotonic), pytest; TypeScript / Next 16, vitest. Python tests run from `scripts/`; TS tests via `npx vitest run`.

**Spec:** `docs/superpowers/specs/2026-06-20-calibration-honest-tiers-design.md`

---

## File Structure

- Create: `scripts/tier_thresholds.py` — pure `derive_tier_thresholds(lookup, targets)` + `DEFAULT_TARGETS`. No I/O.
- Create: `scripts/tests/test_tier_thresholds.py` — pytest for the derivation.
- Create: `scripts/validate_tier_thresholds.py` — leak-free held-out validation (adoption gate).
- Modify: `scripts/build_calibration.py` — emit a `tier_thresholds` block.
- Modify: `lib/calibration.ts` — `pickTierThresholds(table, stat)` + `tierThresholds(stat)` + table typing.
- Modify: `lib/confidence.ts` — `assignTier()` (pure) + rewrite `getLabel` (drop LEAN) + export `getLabel`.
- Create: `lib/__tests__/tiers.test.ts` — vitest for `assignTier` + `pickTierThresholds`.
- Modify: `app/api/enrich/route.ts` — delete `adjAltLabel`, label alt lines via `getLabel`.
- Modify: `scripts/auto_retrain.py` — stop writing `lock/play_thresholds`.
- Modify: `types/index.ts` — annotate `'LEAN'`/`'MED_RISK'` legacy.
- Modify: `app/edge/page.tsx`, `app/game/[id]/page.tsx` — drop LEAN from live tier display.

**Test commands:** Python: `cd scripts && python3 -m pytest tests/test_tier_thresholds.py -v`. TS: `npx vitest run lib/__tests__/tiers.test.ts`. Commit messages end with `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`. Do not push.

---

## Task 1: Pure threshold-derivation helper (Python)

**Files:**
- Create: `scripts/tier_thresholds.py`
- Test: `scripts/tests/test_tier_thresholds.py`

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/test_tier_thresholds.py`:

```python
from tier_thresholds import derive_tier_thresholds, DEFAULT_TARGETS

def _curve(points):
    """Build a 101-length monotonic non-decreasing calibrated-percent lookup.
    points: {raw_score: calibrated_pct} dict (passed positionally, NOT
    **-unpacked — Python 3.14 forbids integer kwarg keys)."""
    arr = [0.0] * 101
    keys = sorted(points)
    for i in range(101):
        # value = the last given point at or below i
        v = 0.0
        for k in keys:
            if k <= i:
                v = points[k]
        arr[i] = v
    return arr

def test_default_targets_are_lock60_play55():
    assert DEFAULT_TARGETS == {"lock": 0.60, "play": 0.55}

def test_derives_lowest_raw_crossing_target():
    # calibrated hits 55% at raw 70, 60% at raw 80
    lookup = _curve({0: 30.0, 70: 55.0, 80: 60.0})
    out = derive_tier_thresholds(lookup, {"lock": 0.60, "play": 0.55})
    assert out == {"lock": 80, "play": 70}

def test_null_when_curve_never_reaches_target():
    # caps at 58% — never reaches 60% LOCK target
    lookup = _curve({0: 30.0, 70: 55.0, 90: 58.0})
    out = derive_tier_thresholds(lookup, {"lock": 0.60, "play": 0.55})
    assert out == {"lock": None, "play": 70}

def test_monotonic_lock_ge_play():
    lookup = _curve({0: 40.0, 60: 55.0, 75: 60.0})
    out = derive_tier_thresholds(lookup, DEFAULT_TARGETS)
    assert out["lock"] >= out["play"]
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /c/Users/dcho0/nbaiqproject/scripts && python3 -m pytest tests/test_tier_thresholds.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'tier_thresholds'`.

- [ ] **Step 3: Implement**

Create `scripts/tier_thresholds.py`:

```python
"""Pure derivation of LOCK/PLAY raw-score thresholds from a calibration curve.

A tier's raw threshold is the lowest raw score (0-100) whose calibrated hit-rate
clears the tier's target. None when the (sample-capped) curve never reaches it —
that stat earns no picks at that tier. No I/O; imported by build_calibration.py,
validate_tier_thresholds.py, and the tests.
"""
from __future__ import annotations

# The product ladder. Vig-aware: -110 breakeven is 52.38%, so both clear it.
DEFAULT_TARGETS = {"lock": 0.60, "play": 0.55}

def derive_tier_thresholds(lookup, targets=DEFAULT_TARGETS):
    """lookup: 101 calibrated hit-rate PERCENTS (0-100), monotonic non-decreasing.
    targets: {tier: fraction in [0,1]}. Returns {tier: int raw score | None}."""
    out = {}
    for tier, frac in targets.items():
        target_pct = frac * 100.0
        threshold = None
        for raw in range(len(lookup)):
            if lookup[raw] + 1e-9 >= target_pct:  # epsilon: exact-boundary value clears float-inflated target
                threshold = raw
                break
        out[tier] = threshold
    return out
```

- [ ] **Step 4: Run to verify pass**

Run: `cd /c/Users/dcho0/nbaiqproject/scripts && python3 -m pytest tests/test_tier_thresholds.py -v`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add scripts/tier_thresholds.py scripts/tests/test_tier_thresholds.py
git commit -m "feat(calibration): pure tier-threshold derivation from curve"
```

---

## Task 2: Emit `tier_thresholds` from build_calibration.py

**Files:**
- Modify: `scripts/build_calibration.py`

- [ ] **Step 1: Add the import**

In `scripts/build_calibration.py`, add after the existing `import requests` line (~line 35):

```python
from tier_thresholds import derive_tier_thresholds, DEFAULT_TARGETS
```

- [ ] **Step 2: Compute the block before writing the payload**

In `scripts/build_calibration.py`, immediately BEFORE the `payload = {` line (~line 195), insert:

```python
    # Derive calibration-honest tier thresholds (see scripts/tier_thresholds.py
    # and the design spec). Per-stat where a per-stat curve exists; _global is the
    # fallback used by stats without their own curve.
    tier_thresholds = {
        '_targets': DEFAULT_TARGETS,
        '_global': derive_tier_thresholds(global_lookup, DEFAULT_TARGETS),
    }
    for stat, lookup in per_stat.items():
        tier_thresholds[stat] = derive_tier_thresholds(lookup, DEFAULT_TARGETS)
    print(f"  tier_thresholds (LOCK>={DEFAULT_TARGETS['lock']:.0%}, "
          f"PLAY>={DEFAULT_TARGETS['play']:.0%}):")
    for k, v in tier_thresholds.items():
        if not k.startswith('_'):
            print(f"    {k:<14} lock={v['lock']}  play={v['play']}")
```

- [ ] **Step 3: Add it to the payload dict**

In `scripts/build_calibration.py`, in the `payload = { ... }` dict, add this key right after the `'sample_counts': sample_counts,` line:

```python
        'tier_thresholds': tier_thresholds,
```

- [ ] **Step 4: Regenerate the table and verify the block exists**

Run:
```bash
cd /c/Users/dcho0/nbaiqproject && set -a && source <(grep -E '^(NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_KEY)=' .env.local | sed 's/\r$//') && set +a && PYTHONIOENCODING=utf-8 python3 scripts/build_calibration.py
```
Then:
```bash
cd /c/Users/dcho0/nbaiqproject && python3 -c "import json; d=json.load(open('lib/calibration-table.json')); print('has block:', 'tier_thresholds' in d); print(json.dumps(d['tier_thresholds'], indent=1))"
```
Expected: `has block: True` and a `_targets`/`_global`/per-stat structure printed (e.g. `rebounds: {lock: <int>, play: <int>}`, possibly `three_pointers: {lock: null, ...}`).

- [ ] **Step 5: Commit**

```bash
git add scripts/build_calibration.py lib/calibration-table.json
git commit -m "feat(calibration): emit tier_thresholds block in calibration table"
```

---

## Task 3: Leak-free validation (adoption gate)

**Files:**
- Create: `scripts/validate_tier_thresholds.py`

This task produces the EVIDENCE for adopting the 60/55 targets. It is data-dependent — run it and inspect the report against the adoption criterion in Step 3.

- [ ] **Step 1: Implement the validator**

Create `scripts/validate_tier_thresholds.py`:

```python
"""Leak-free validation of calibration-derived tier thresholds.

Fit the isotonic calibration on game_date < cutoff, derive tier thresholds from
that TRAIN fit, then assign tiers on the held-out window (>= cutoff) using the
stored RAW confidence_score and report each tier's actual hit-rate, volume, and
EV at -110. Adopt the targets only if held-out LOCK/PLAY clear their floors.

Usage:
    python3 scripts/validate_tier_thresholds.py --cutoff 2026-04-15
"""
import os, sys, argparse
from collections import defaultdict

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
import numpy as np
from sklearn.isotonic import IsotonicRegression
from tier_thresholds import derive_tier_thresholds, DEFAULT_TARGETS

SUPABASE_URL = (os.environ.get('NEXT_PUBLIC_SUPABASE_URL') or env.get('NEXT_PUBLIC_SUPABASE_URL', '')).strip('"').strip("'")
SUPABASE_KEY = (os.environ.get('SUPABASE_SERVICE_KEY') or env.get('SUPABASE_SERVICE_KEY', '')).strip('"').strip("'")
HEADERS = {'apikey': SUPABASE_KEY, 'Authorization': f'Bearer {SUPABASE_KEY}'}
BREAKEVEN = 110 / 210  # -110 juice = 0.5238

def sb_get_all(table, params=''):
    rows, offset = [], 0
    while True:
        sep = '&' if params else ''
        url = f'{SUPABASE_URL}/rest/v1/{table}?{params}{sep}limit=1000&offset={offset}'
        r = requests.get(url, headers=HEADERS, timeout=30); r.raise_for_status()
        batch = r.json()
        if not batch: break
        rows.extend(batch)
        if len(batch) < 1000: break
        offset += 1000
    return rows

def fit_lookup(scores, hits):
    iso = IsotonicRegression(y_min=0.0, y_max=1.0, out_of_bounds='clip')
    iso.fit(scores, hits)
    return (iso.predict(np.arange(0, 101, 1)) * 100).round(2).tolist()

def assign(score, thr):
    if thr['lock'] is not None and score >= thr['lock']: return 'LOCK'
    if thr['play'] is not None and score >= thr['play']: return 'PLAY'
    return 'FADE'

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cutoff', default='2026-04-15', help='train < cutoff, test >= cutoff')
    args = ap.parse_args()

    grades = sb_get_all('prop_grades')
    grades = [g for g in grades if g.get('hit') is not None and g.get('confidence_score') is not None]
    train = [g for g in grades if g['game_date'] < args.cutoff]
    test  = [g for g in grades if g['game_date'] >= args.cutoff]
    print(f"train={len(train):,}  test={len(test):,}  cutoff={args.cutoff}")
    if len(train) < 2000 or len(test) < 500:
        print("INSUFFICIENT data for a leak-free split"); sys.exit(1)

    ts = np.array([float(g['confidence_score']) for g in train])
    th = np.array([1 if g['hit'] else 0 for g in train])
    stt = np.array([g.get('stat_type', '') for g in train])

    # Derive thresholds from the TRAIN fit (global + per-stat).
    thr_by_stat = {'_global': derive_tier_thresholds(fit_lookup(ts, th), DEFAULT_TARGETS)}
    for stat in ['points', 'rebounds', 'assists', 'pra', 'steals', 'blocks', 'three_pointers']:
        m = stt == stat
        if int(m.sum()) >= 500:
            thr_by_stat[stat] = derive_tier_thresholds(fit_lookup(ts[m], th[m]), DEFAULT_TARGETS)

    print("\n  Train-derived thresholds:")
    for k, v in thr_by_stat.items():
        print(f"    {k:<14} lock={v['lock']}  play={v['play']}")

    # Assign tiers on held-out and tally.
    tally = defaultdict(lambda: [0, 0])  # tier -> [hits, n]
    for g in test:
        thr = thr_by_stat.get(g.get('stat_type', ''), thr_by_stat['_global'])
        tier = assign(float(g['confidence_score']), thr)
        tally[tier][0] += 1 if g['hit'] else 0
        tally[tier][1] += 1

    print(f"\n  Held-out tier performance (breakeven @ -110 = {BREAKEVEN:.1%}):")
    print(f"  {'TIER':<6}{'N':>7}{'HIT':>8}{'EV/$1':>9}")
    for tier in ['LOCK', 'PLAY', 'FADE']:
        hits, n = tally[tier]
        if n == 0:
            print(f"  {tier:<6}{0:>7}{'--':>8}{'--':>9}"); continue
        hr = hits / n
        ev = hr * (100/110) - (1 - hr)  # win 100/110 units, lose 1
        print(f"  {tier:<6}{n:>7}{hr:>7.1%}{ev:>+9.3f}")

    lock_hr = (tally['LOCK'][0] / tally['LOCK'][1]) if tally['LOCK'][1] else 0
    play_hr = (tally['PLAY'][0] / tally['PLAY'][1]) if tally['PLAY'][1] else 0
    print(f"\n  ADOPTION CHECK: LOCK {lock_hr:.1%} (target 60%), PLAY {play_hr:.1%} (target 55%)")
    print("  Adopt if both clear breakeven (52.4%) with margin and volumes are non-trivial.")

if __name__ == '__main__':
    main()
```

- [ ] **Step 2: Run the validation**

Run:
```bash
cd /c/Users/dcho0/nbaiqproject && set -a && source <(grep -E '^(NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_KEY)=' .env.local | sed 's/\r$//') && set +a && python3 scripts/validate_tier_thresholds.py --cutoff 2026-04-15
```
Expected: prints train/test sizes, train-derived thresholds, and a held-out tier table with N / HIT / EV per tier.

- [ ] **Step 3: Inspect against the adoption criterion (decision point)**

Adoption criterion: held-out **LOCK ≥ ~58%** and **PLAY ≥ ~54%** (allowing sampling noise below the 60/55 targets), both with **EV/$1 > 0**, and non-trivial volume (LOCK n ≥ 20, PLAY n ≥ 50).
- If met → targets are validated; proceed with 60/55 (already the default).
- If NOT met (a tier is negative-EV out-of-sample, or volumes are ~0) → STOP and report the numbers to the user; adjust `DEFAULT_TARGETS` in `scripts/tier_thresholds.py` (e.g. LOCK 0.58 / PLAY 0.54), re-run Task 2 Step 4 + this validation, and re-confirm before continuing. Do not silently ship failing targets.

- [ ] **Step 4: Commit**

```bash
git add scripts/validate_tier_thresholds.py
git commit -m "feat(calibration): leak-free tier-threshold validation harness"
```

---

## Task 4: `tierThresholds` reader in calibration.ts

**Files:**
- Modify: `lib/calibration.ts`
- Create: `lib/__tests__/tiers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/__tests__/tiers.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { pickTierThresholds } from '../calibration'

const TABLE = {
  tier_thresholds: {
    _targets: { lock: 0.6, play: 0.55 },
    _global: { lock: 78, play: 73 },
    rebounds: { lock: 76, play: 71 },
    three_pointers: { lock: null, play: 77 },
  },
}

describe('pickTierThresholds', () => {
  it('returns the per-stat entry when present', () => {
    expect(pickTierThresholds(TABLE, 'rebounds')).toEqual({ lock: 76, play: 71 })
  })
  it('falls back to _global when stat has no entry', () => {
    expect(pickTierThresholds(TABLE, 'points')).toEqual({ lock: 78, play: 73 })
  })
  it('preserves a deliberate null lock (stat cannot earn that tier)', () => {
    expect(pickTierThresholds(TABLE, 'three_pointers')).toEqual({ lock: null, play: 77 })
  })
  it('returns null when the table has no tier_thresholds block', () => {
    expect(pickTierThresholds({}, 'points')).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /c/Users/dcho0/nbaiqproject && npx vitest run lib/__tests__/tiers.test.ts`
Expected: FAIL — `pickTierThresholds` is not exported.

- [ ] **Step 3: Implement**

In `lib/calibration.ts`, add to the `CalibrationTable` interface (after the `sample_counts?` line ~44):

```typescript
  /** Per-stat LOCK/PLAY raw-score thresholds derived from the calibration curve. */
  tier_thresholds?: {
    _targets?: { lock: number; play: number }
    [key: string]: { lock: number | null; play: number | null } | { lock: number; play: number } | undefined
  }
```

Then add these exports at the end of `lib/calibration.ts`:

```typescript
export interface TierThresholds { lock: number | null; play: number | null }

/**
 * Calibration-derived LOCK/PLAY raw-score thresholds for a stat. Per-stat entry
 * preferred, `_global` as fallback. Returns null when the table has no
 * tier_thresholds block (caller then falls back to config/defaults). A null
 * `lock`/`play` inside a returned object is deliberate — that stat's curve never
 * reaches the target, so it earns no picks at that tier.
 */
export function pickTierThresholds(table: unknown, statType?: string): TierThresholds | null {
  const tt = (table as CalibrationTable)?.tier_thresholds
  if (!tt) return null
  const src = (statType && tt[statType]) || tt._global
  if (!src || !('lock' in src)) return null
  return { lock: src.lock ?? null, play: src.play ?? null }
}

export function tierThresholds(statType?: string): TierThresholds | null {
  return pickTierThresholds(TABLE, statType)
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd /c/Users/dcho0/nbaiqproject && npx vitest run lib/__tests__/tiers.test.ts`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add lib/calibration.ts lib/__tests__/tiers.test.ts
git commit -m "feat(calibration): tierThresholds reader (per-stat + global fallback)"
```

---

## Task 5: Rewrite `getLabel` to gate on calibration thresholds (drop LEAN)

**Files:**
- Modify: `lib/confidence.ts`
- Modify: `lib/__tests__/tiers.test.ts`

- [ ] **Step 1: Add failing tests for `assignTier`**

Append to `lib/__tests__/tiers.test.ts`:

```typescript
import { assignTier } from '../confidence'

describe('assignTier', () => {
  it('LOCK at/above lock threshold', () => {
    expect(assignTier(80, 78, 73)).toEqual({ label: 'LOCK', tier: 'PRIME' })
  })
  it('PLAY between play and lock', () => {
    expect(assignTier(75, 78, 73)).toEqual({ label: 'PLAY', tier: 'LOW_RISK' })
  })
  it('FADE below play', () => {
    expect(assignTier(60, 78, 73)).toEqual({ label: 'FADE', tier: 'HIGH_RISK' })
  })
  it('never returns LEAN', () => {
    for (const s of [0, 50, 60, 73, 78, 90]) {
      expect(assignTier(s, 78, 73).label).not.toBe('LEAN')
    }
  })
  it('null lock falls through to PLAY (stat cannot earn LOCK)', () => {
    expect(assignTier(95, null, 77)).toEqual({ label: 'PLAY', tier: 'LOW_RISK' })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /c/Users/dcho0/nbaiqproject && npx vitest run lib/__tests__/tiers.test.ts`
Expected: FAIL — `assignTier` is not exported from `../confidence`.

- [ ] **Step 3: Implement — add `assignTier`, import `tierThresholds`, rewrite `getLabel`, export it**

In `lib/confidence.ts`, the existing re-export line (~103) is:
```typescript
export { applyCalibration } from '@/lib/calibration'
```
Replace it with:
```typescript
export { applyCalibration } from '@/lib/calibration'
import { tierThresholds } from '@/lib/calibration'
```

In `lib/confidence.ts`, replace the entire `getLabel` function (currently lines ~1498-1506) with:

```typescript
/**
 * Pure tier assignment from raw score + raw-score thresholds. LOCK/PLAY/FADE
 * only — the LEAN tier was removed (its ~52% edge loses to -110 juice). A null
 * threshold means "this stat cannot earn that tier"; skip it. Exported for tests.
 */
export function assignTier(
  score: number,
  lock: number | null,
  play: number | null,
): { label: ConfidenceLabel; tier: RiskTier } {
  if (lock != null && score >= lock) return { label: 'LOCK', tier: 'PRIME'     }
  if (play != null && score >= play) return { label: 'PLAY', tier: 'LOW_RISK'  }
  return                                    { label: 'FADE', tier: 'HIGH_RISK' }
}

export function getLabel(score: number, statType?: StatType): { label: ConfidenceLabel; tier: RiskTier } {
  // 1. Calibration-derived thresholds win when present (authoritative, incl.
  //    deliberate nulls). 2. Else fall back to confidence-weights config. 3. Else
  //    code defaults. Sorting/dedup still use raw scores elsewhere — unchanged.
  const ct = statType ? tierThresholds(statType) : tierThresholds()
  if (ct) return assignTier(score, ct.lock, ct.play)

  const config = loadWeightConfig()
  const lock = (statType && (config?.lock_thresholds[statType] ?? LOCK_THRESHOLD_BY_STAT[statType])) ?? (config?.base_lock_threshold ?? 74)
  const play = (statType && (config?.play_thresholds[statType] ?? PLAY_THRESHOLD_BY_STAT[statType])) ?? (config?.base_play_threshold ?? 68)
  return assignTier(score, lock, play)
}
```

(`getLabel` keeps the same signature, so its two existing call sites at lines ~1276 and ~1431 are unaffected.)

- [ ] **Step 4: Run to verify pass**

Run: `cd /c/Users/dcho0/nbaiqproject && npx vitest run lib/__tests__/tiers.test.ts`
Expected: PASS (9 passed).

- [ ] **Step 5: Verify the full existing TS suite still passes**

Run: `cd /c/Users/dcho0/nbaiqproject && npx vitest run`
Expected: all test files pass (confidence + odds-api + tiers).

- [ ] **Step 6: Commit**

```bash
git add lib/confidence.ts lib/__tests__/tiers.test.ts
git commit -m "feat(confidence): getLabel gates on calibration thresholds; drop LEAN tier"
```

---

## Task 6: Unify the alt-line labeler onto `getLabel`

**Files:**
- Modify: `app/api/enrich/route.ts`

- [ ] **Step 1: Import `getLabel`**

In `app/api/enrich/route.ts`, the scoring imports near the top include `scoreProps` (~line 20). Add `getLabel` to that import from `@/lib/confidence`. The import block currently looks like:
```typescript
  scoreProps,
```
Change it to:
```typescript
  scoreProps,
  getLabel,
```

- [ ] **Step 2: Delete `adjAltLabel` and its hardcoded threshold tables**

In `app/api/enrich/route.ts`, delete these blocks (currently ~lines 767-776):

```typescript
  const ALT_LOCK_T: Partial<Record<string, number>> = {
    assists: 74, pra: 78, steals: 72, blocks: 72, three_pointers: 72,
  }
  const ALT_PLAY_T: Partial<Record<string, number>> = { assists: 70, pra: 68 }
  function adjAltLabel(score: number, statType: string): ConfidenceLabel {
    if (score >= (ALT_LOCK_T[statType] ?? 68)) return 'LOCK'
    if (score >= (ALT_PLAY_T[statType] ?? 60)) return 'PLAY'
    if (score >= 50) return 'LEAN'
    return 'FADE'
  }
```

- [ ] **Step 3: Use `getLabel` for the alt-line label**

In `app/api/enrich/route.ts`, the alt return (currently ~line 855) is:
```typescript
      return { ...alt, confidence_score: adjScore, confidence_label: adjAltLabel(adjScore, pseudoProp.stat_type) }
```
Change it to:
```typescript
      return { ...alt, confidence_score: adjScore, confidence_label: getLabel(adjScore, pseudoProp.stat_type).label }
```

- [ ] **Step 4: Typecheck**

Run: `cd /c/Users/dcho0/nbaiqproject && npx tsc --noEmit 2>&1 | grep -E "enrich/route|adjAltLabel|getLabel" || echo "no errors in enrich route"`
Expected: `no errors in enrich route` (and no "adjAltLabel is not defined").

- [ ] **Step 5: Commit**

```bash
git add app/api/enrich/route.ts
git commit -m "refactor(enrich): label alt lines via getLabel (unify the two labelers)"
```

---

## Task 7: Stop auto_retrain.py writing tier thresholds

**Files:**
- Modify: `scripts/auto_retrain.py`

Calibration now owns tier thresholds; auto_retrain must not write competing values into `confidence-weights.json`.

- [ ] **Step 1: Find where auto_retrain emits thresholds**

Run: `cd /c/Users/dcho0/nbaiqproject && grep -n "lock_thresholds\|play_thresholds\|find_best_threshold\|new_lock_thresholds\|new_play_thresholds\|base_lock\|base_play" scripts/auto_retrain.py | head -30`
Expected: shows the threshold-search call(s) and where `lock_thresholds`/`play_thresholds` are placed into the output dict.

- [ ] **Step 2: Make the output carry forward the EXISTING thresholds instead of newly-searched ones**

In `scripts/auto_retrain.py`, in the output `payload`/`output` dict (the one written to JSON, ~lines 960-973), change the threshold fields so they preserve the current config rather than the searched values. Replace:
```python
        'lock_thresholds': new_lock_thresholds,
        'play_thresholds': new_play_thresholds,
        'base_lock_threshold': base_lock,
        'base_play_threshold': base_play,
```
with:
```python
        # Thresholds are owned by build_calibration.py (calibration-table.json
        # tier_thresholds). Carry the current config's values forward unchanged as
        # an inert fallback — do NOT search/overwrite them here.
        'lock_thresholds': current_config.get('lock_thresholds', {}) if current_config else {},
        'play_thresholds': current_config.get('play_thresholds', {}) if current_config else {},
        'base_lock_threshold': current_config.get('base_lock_threshold', 74) if current_config else 74,
        'base_play_threshold': current_config.get('base_play_threshold', 68) if current_config else 68,
```

- [ ] **Step 3: Compile-check**

Run: `cd /c/Users/dcho0/nbaiqproject && python3 -m py_compile scripts/auto_retrain.py && echo "COMPILE OK"`
Expected: `COMPILE OK`.

- [ ] **Step 4: Commit**

```bash
git add scripts/auto_retrain.py
git commit -m "refactor(auto_retrain): defer tier thresholds to calibration (carry forward, no search)"
```

---

## Task 8: Annotate LEAN legacy + drop LEAN from live UI

**Files:**
- Modify: `types/index.ts`
- Modify: `app/edge/page.tsx`
- Modify: `app/game/[id]/page.tsx`

- [ ] **Step 1: Annotate the type (keep LEAN as legacy)**

In `types/index.ts`, replace lines 28-29:
```typescript
export type ConfidenceLabel = 'LOCK' | 'PLAY' | 'LEAN' | 'FADE'
export type RiskTier = 'PRIME' | 'LOW_RISK' | 'MED_RISK' | 'HIGH_RISK'
```
with:
```typescript
// 'LEAN'/'MED_RISK' are LEGACY: no longer emitted by getLabel (removed 2026-06,
// sub-vig tier). Kept in the union so historical rows + analytics still typecheck.
export type ConfidenceLabel = 'LOCK' | 'PLAY' | 'LEAN' | 'FADE'
export type RiskTier = 'PRIME' | 'LOW_RISK' | 'MED_RISK' | 'HIGH_RISK'
```

- [ ] **Step 2: Drop LEAN from the edge page live tier chips**

In `app/edge/page.tsx`, line ~99:
```typescript
  const byTier: Record<string, number> = { LOCK: 0, PLAY: 0, LEAN: 0, FADE: 0 }
```
change to:
```typescript
  const byTier: Record<string, number> = { LOCK: 0, PLAY: 0, FADE: 0 }
```
And the chip list at line ~119:
```typescript
        {(['LOCK', 'PLAY', 'LEAN', 'FADE'] as const).map((tier) => (
```
change to:
```typescript
        {(['LOCK', 'PLAY', 'FADE'] as const).map((tier) => (
```

- [ ] **Step 3: Drop LEAN from the game page tier ordering/counts**

In `app/game/[id]/page.tsx`, line ~57:
```typescript
  const TIER_ORDER: Record<string, number> = { LOCK: 0, PLAY: 1, LEAN: 2, FADE: 3 }
```
change to:
```typescript
  const TIER_ORDER: Record<string, number> = { LOCK: 0, PLAY: 1, FADE: 2 }
```
Delete the LEAN count declaration (line ~267):
```typescript
  const lean = props.filter((p) => p.confidence_label === 'LEAN').length
```
And delete the "Lean" stat card from the confidence-summary JSX (lines ~302-305) — the whole `<div>` that renders `{lean}`:
```typescript
          <div className="px-4 py-2 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-sm">
            <span className="text-yellow-400 font-semibold">{lean}</span>
            <span className="text-white/40 ml-1.5">Lean</span>
          </div>
```
Then confirm no `lean` references remain:
Run: `cd /c/Users/dcho0/nbaiqproject && grep -n "\blean\b" "app/game/[id]/page.tsx"`
Expected: no output (all references removed).

- [ ] **Step 4: Typecheck**

Run: `cd /c/Users/dcho0/nbaiqproject && npx tsc --noEmit 2>&1 | grep -E "edge/page|game/\[id\]/page|types/index" || echo "no errors in touched UI files"`
Expected: `no errors in touched UI files`.

- [ ] **Step 5: Commit**

```bash
git add types/index.ts app/edge/page.tsx "app/game/[id]/page.tsx"
git commit -m "refactor(ui): drop LEAN from live tier display; annotate LEAN legacy"
```

---

## Task 9: Full verification + production rollout

**Files:** none (verification + deploy).

- [ ] **Step 1: Full TS suite + typecheck**

Run: `cd /c/Users/dcho0/nbaiqproject && npx vitest run 2>&1 | tail -5 && npx tsc --noEmit 2>&1 | tail -5`
Expected: all vitest tests pass; `tsc --noEmit` prints no errors.

- [ ] **Step 2: Full Python suite**

Run: `cd /c/Users/dcho0/nbaiqproject/scripts && python3 -m pytest tests/ -q 2>&1 | tail -5`
Expected: all pass (existing + `test_tier_thresholds.py`).

- [ ] **Step 3: Production build**

Run: `cd /c/Users/dcho0/nbaiqproject && npx next build 2>&1 | tail -15`
Expected: build completes with no type/lint errors.

- [ ] **Step 4: Deploy to production**

(Prod does NOT auto-deploy from push — see the Prizm feedback memory.) Confirm with the user before deploying, then:
```bash
cd /c/Users/dcho0/nbaiqproject && git push origin master && npx vercel --prod --yes 2>&1 | tail -8
```
Expected: `● Ready`, `target: production`, aliased to `prizmproject.vercel.app`.

- [ ] **Step 5: Re-enrich and sanity-check labels**

Run:
```bash
cd /c/Users/dcho0/nbaiqproject && set -a && source <(grep -E '^(NEXT_PUBLIC_SITE_URL|CRON_SECRET)=' .env.local | sed 's/\r$//') && set +a && curl -s --max-time 300 -H "Authorization: Bearer $CRON_SECRET" "$NEXT_PUBLIC_SITE_URL/api/enrich?force=true" | head -c 200; echo
```
Then check the live label distribution:
```bash
cd /c/Users/dcho0/nbaiqproject && set -a && source <(grep -E '^(NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_KEY)=' .env.local | sed 's/\r$//') && set +a && python3 -c "
import requests, os, collections
U=os.environ['NEXT_PUBLIC_SUPABASE_URL']; K=os.environ['SUPABASE_SERVICE_KEY']; H={'apikey':K,'Authorization':f'Bearer {K}'}
rows=requests.get(f'{U}/rest/v1/props?select=confidence_label',headers=H,timeout=30).json()
print('live label counts:', dict(collections.Counter(r.get('confidence_label') for r in rows)))
"
```
Expected: newly-enriched props show only `LOCK`/`PLAY`/`FADE` (no new `LEAN`). Offseason caveat: if there's no live slate, this re-enriches the last cached slate — confirm no `LEAN` appears among freshly written rows.

- [ ] **Step 6: Final commit (if any verification fixups were needed)**

Only if Steps 1-3 surfaced a fixup. Otherwise this task has no commit.

---

## Self-Review notes

- **Spec coverage:** Approach B derivation (Task 1-2), tier_thresholds in calibration table (Task 2), `tierThresholds` reader + precedence (Task 4), `getLabel` calibration-gated + LEAN dropped (Task 5), labeler unification (Task 6), auto_retrain threshold retirement (Task 7), forward-only LEAN deprecation + legacy type + live-UI removal with historical analytics untouched (Task 8), leak-free validation gate (Task 3), no Supabase DDL (no task touches schema — by design), testing in pytest + vitest (Tasks 1,4,5), rollout incl. `vercel --prod` (Task 9). All spec sections map to a task.
- **Type consistency:** `derive_tier_thresholds(lookup, targets)→{lock,play}` (Py) used identically in Tasks 1-3; `pickTierThresholds(table, stat)`/`tierThresholds(stat)`→`{lock,play}|null` (Task 4) consumed by `getLabel` (Task 5); `assignTier(score, lock, play)` defined and used in Task 5; `getLabel(score, statType)→{label,tier}` signature unchanged, reused in Task 6.
- **No data migration / DDL:** intentional — Section "Supabase / data" of the spec. Historical LEAN rows preserved.
