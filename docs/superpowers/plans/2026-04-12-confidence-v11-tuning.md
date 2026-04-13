# Confidence Engine v11 Tuning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply 5 data-driven fixes to `lib/confidence.ts` to improve LOCK/PLAY accuracy based on diagnostic pipeline findings.

**Architecture:** All changes are in a single file (`lib/confidence.ts`). Each task modifies a specific section: weight objects, over-bias logic, threshold constants, or the version header. Tasks are ordered so each produces a valid, independently committable change.

**Tech Stack:** TypeScript (Next.js), Python (diagnostic validation)

---

### Task 1: Update Weight Sets — Reduce trend + Drop restDays

**Files:**
- Modify: `lib/confidence.ts:197-299` (all 7 weight objects)

The `trend` factor is anti-correlated (AUC 0.490) and `restDays` has no significant correlation (p=0.279). Halve trend, set restDays to 0.01, redistribute freed weight to last20HitRate (60%) and homeAway (40%), normalize all sets to sum 1.00.

- [ ] **Step 1: Update W_POINTS**

Replace lines 197-209:

```typescript
// Points: last20HitRate dominant after v11 rebalance; trend+restDays demoted (diagnostic: anti-correlated/no signal).
const W_POINTS = {
  lineValue:      0.07,
  matchupEdge:    0.02,
  last20HitRate:  0.24,
  trend:          0.03,
  seasonCushion:  0.10,
  pace:           0.17,
  newsInjury:     0.13,
  restDays:       0.01,
  blowout:        0.08,
  homeAway:       0.13,
  vsOpponent:     0.02,
}
```

- [ ] **Step 2: Update W_REBOUNDS**

Replace lines 211-224:

```typescript
// Rebounds: homeAway confirmed dominant (5th consecutive run). trend+restDays demoted.
const W_REBOUNDS = {
  lineValue:      0.02,
  matchupEdge:    0.03,
  last20HitRate:  0.10,
  trend:          0.01,
  seasonCushion:  0.04,
  pace:           0.08,
  newsInjury:     0.13,
  restDays:       0.01,
  blowout:        0.04,
  homeAway:       0.52,
  vsOpponent:     0.02,
}
```

- [ ] **Step 3: Update W_ASSISTS**

Replace lines 226-239:

```typescript
// Assists: seasonCushion dominates; vsOpponent confirmed strong. trend+restDays demoted.
const W_ASSISTS = {
  lineValue:      0.05,
  matchupEdge:    0.04,
  last20HitRate:  0.06,
  trend:          0.02,
  seasonCushion:  0.26,
  pace:           0.13,
  newsInjury:     0.09,
  restDays:       0.01,
  blowout:        0.06,
  homeAway:       0.12,
  vsOpponent:     0.16,
}
```

- [ ] **Step 4: Update W_PRA**

Replace lines 241-254:

```typescript
// PRA: seasonCushion + homeAway dominate composite totals. trend+restDays demoted.
const W_PRA = {
  lineValue:      0.04,
  matchupEdge:    0.07,
  last20HitRate:  0.02,
  trend:          0.03,
  seasonCushion:  0.25,
  pace:           0.02,
  newsInjury:     0.06,
  restDays:       0.01,
  blowout:        0.13,
  homeAway:       0.30,
  vsOpponent:     0.07,
}
```

- [ ] **Step 5: Update W_BLOCKS**

Replace lines 256-269:

```typescript
// Blocks: seasonCushion dominant; matchupEdge meaningful via DVP. trend halved, restDays demoted.
const W_BLOCKS = {
  lineValue:      0.02,
  matchupEdge:    0.13,
  last20HitRate:  0.11,
  trend:          0.07,
  seasonCushion:  0.25,
  pace:           0.06,
  newsInjury:     0.10,
  restDays:       0.01,
  blowout:        0.03,
  homeAway:       0.15,
  vsOpponent:     0.07,
}
```

- [ ] **Step 6: Update W_STEALS**

Replace lines 271-284:

```typescript
// Steals: seasonCushion dominant; vsOpponent strong. trend+restDays demoted.
const W_STEALS = {
  lineValue:      0.11,
  matchupEdge:    0.03,
  last20HitRate:  0.13,
  trend:          0.02,
  seasonCushion:  0.29,
  pace:           0.10,
  newsInjury:     0.07,
  restDays:       0.01,
  blowout:        0.03,
  homeAway:       0.04,
  vsOpponent:     0.17,
}
```

- [ ] **Step 7: Update W_THREE_POINTERS**

Replace lines 286-299:

```typescript
// Three-pointers: matchupEdge strongest (DVP confirmed); homeAway elevated. trend+restDays demoted.
const W_THREE_POINTERS = {
  lineValue:      0.07,
  matchupEdge:    0.22,
  last20HitRate:  0.12,
  trend:          0.03,
  seasonCushion:  0.09,
  pace:           0.04,
  newsInjury:     0.06,
  restDays:       0.01,
  blowout:        0.07,
  homeAway:       0.25,
  vsOpponent:     0.04,
}
```

- [ ] **Step 8: Verify all weight sets sum to 1.00**

For each weight set, mentally verify: all values should sum to exactly 1.00.

- [ ] **Step 9: Commit**

```bash
git add lib/confidence.ts
git commit -m "feat(confidence): v11 weights — halve trend, drop restDays, boost last20HitRate+homeAway"
```

---

### Task 2: Stat-Specific Over Bias

**Files:**
- Modify: `lib/confidence.ts:1143-1147` (overBiasAdj)

Replace the flat `-3` over bias with a stat-specific lookup. Steals need -7, blocks -6, based on the diagnostic over/under gap.

- [ ] **Step 1: Add OVER_BIAS_BY_STAT constant**

Find the overBiasAdj section (around line 1143). Replace:

```typescript
  // Over bias correction: empirically, OVER props hit at ~43% vs UNDER at ~50%
  // across 835 graded props (Mar 22-24 sample). Books price popular OVERs above
  // fair value, capturing recency bias from the betting public. Apply -3pt
  // correction to all OVER props to offset this systematic pricing edge.
  const overBiasAdj = direction === 'over' ? -3 : 0
```

With:

```typescript
  // Over bias correction — stat-specific (v11.0, diagnostic data from 71k graded props):
  // Books price popular OVERs above fair value. Gap varies by stat:
  //   steals +19%, blocks +12%, assists +7%, rebounds +7%, 3PM +4.5%, points +3.3%
  const OVER_BIAS_BY_STAT: Record<StatType, number> = {
    points:         -3,
    rebounds:       -4,
    assists:        -4,
    steals:         -7,
    blocks:         -6,
    three_pointers: -3,
    pra:            -4,
  }
  const overBiasAdj = direction === 'over' ? (OVER_BIAS_BY_STAT[stat_type] ?? -3) : 0
```

- [ ] **Step 2: Commit**

```bash
git add lib/confidence.ts
git commit -m "feat(confidence): v11 stat-specific over bias (steals -7, blocks -6)"
```

---

### Task 3: Raise LOCK/PLAY Thresholds for 3PM, Assists, Blocks

**Files:**
- Modify: `lib/confidence.ts:1203-1218` (LOCK_THRESHOLD_BY_STAT, PLAY_THRESHOLD_BY_STAT)

Raise thresholds for the three worst-performing stat types at LOCK tier.

- [ ] **Step 1: Update LOCK_THRESHOLD_BY_STAT**

Replace:

```typescript
const LOCK_THRESHOLD_BY_STAT: Partial<Record<StatType, number>> = {
  assists:        74,  // 64.3% on 14 LOCKs — confirmed; keep at 74
  pra:            78,  // raised from 76 — 76 was hitting 52.2% (too low); 78 gives 72.7%
  steals:         78,  // raised from 76 — 76 was hitting 53.1% (too low); 78 gives 92.9%
  blocks:         74,  // 88.2% on 17 LOCKs — confirmed accurate; keep at 74
  three_pointers: 72,  // 60.0% on 35 LOCKs — best-sampled stat; keep at 72
  rebounds:       74,  // 55.6% on 10 LOCKs — keep at 74; v10 weights may improve
}
```

With:

```typescript
const LOCK_THRESHOLD_BY_STAT: Partial<Record<StatType, number>> = {
  assists:        78,  // v11: raised from 74 — 50.0% on 14 LOCKs was unacceptable
  pra:            78,  // v10: 72.7% — keep at 78
  steals:         78,  // v10: 92.9% — keep at 78
  blocks:         78,  // v11: raised from 74 — 52.6% on 19 LOCKs was too low
  three_pointers: 76,  // v11: raised from 72 — 48.9% on 45 LOCKs was worst performer
  rebounds:       74,  // v10: 66.7% on 24 LOCKs — acceptable, keep at 74
}
```

- [ ] **Step 2: Update PLAY_THRESHOLD_BY_STAT**

Replace:

```typescript
const PLAY_THRESHOLD_BY_STAT: Partial<Record<StatType, number>> = {
  assists:        68,  // LOCK - 6; 51.6% hit rate — keep at 68
  pra:            76,  // raised from 72 — 72 was hitting 40.3%; 76 gives tighter window
  steals:         72,  // LOCK - 6; 55.4% hit rate — keep at 72
  blocks:         72,  // raised from 68 — 68 was hitting 39.5%
  three_pointers: 66,  // LOCK - 6; 53.0% hit rate — keep at 66
  rebounds:       72,  // raised from 68 — 68 was hitting 46.8%; 72 gives 60.0%
  points:         70,  // raised from 66 (default) — 66 was hitting 42.5%
}
```

With:

```typescript
const PLAY_THRESHOLD_BY_STAT: Partial<Record<StatType, number>> = {
  assists:        72,  // v11: raised from 68 — LOCK-6
  pra:            76,  // v10: keep at 76
  steals:         72,  // v10: keep at 72
  blocks:         74,  // v11: raised from 72 — LOCK-4 (tighter band for volatile stat)
  three_pointers: 70,  // v11: raised from 66 — LOCK-6
  rebounds:       72,  // v10: keep at 72
  points:         70,  // v10: keep at 70
}
```

- [ ] **Step 3: Commit**

```bash
git add lib/confidence.ts
git commit -m "feat(confidence): v11 raise LOCK thresholds for 3PM/assists/blocks"
```

---

### Task 4: Raise Base LOCK/PLAY Thresholds

**Files:**
- Modify: `lib/confidence.ts:1221-1223` (getLabel function defaults)

The calibration curve shows scores 70-75 hit at 56.8% (should be 72.5%). Raise base thresholds.

- [ ] **Step 1: Update getLabel defaults**

Replace:

```typescript
  const lockThreshold = (statType && LOCK_THRESHOLD_BY_STAT[statType]) ?? 72  // v8.0: calibrated per-stat; base 72 unchanged
  const playThreshold = (statType && PLAY_THRESHOLD_BY_STAT[statType]) ?? 66  // LOCK - 6
```

With:

```typescript
  const lockThreshold = (statType && LOCK_THRESHOLD_BY_STAT[statType]) ?? 74  // v11: raised from 72 — calibration shows 70-75 scores hit 56.8% (overconfident)
  const playThreshold = (statType && PLAY_THRESHOLD_BY_STAT[statType]) ?? 68  // v11: raised from 66 — LOCK - 6
```

- [ ] **Step 2: Commit**

```bash
git add lib/confidence.ts
git commit -m "feat(confidence): v11 raise base LOCK 72->74, PLAY 66->68"
```

---

### Task 5: Update Version Header + Validate

**Files:**
- Modify: `lib/confidence.ts:1-45` (header comment)

- [ ] **Step 1: Update the version header**

Replace lines 1-7:

```typescript
// Prizm Confidence Engine v10.0
//
// Weights: v9.0 (unchanged). Threshold-only update targeting >60% LOCK and >50% PLAY.
//   LOCK thresholds: pra/steals raised 76→78 (both were hitting <54% at 76)
//   PLAY thresholds: points 66→70, rebounds 68→72, blocks 68→72, pra 72→76
//                    (all were hitting <47% — raised to cut borderline picks into LEAN)
//   Backtest results: LOCK 66.4% on 110 props | PLAY 52.8% on 415 props (75 game days, Dec 26–Mar 19)
```

With:

```typescript
// Prizm Confidence Engine v11.0
//
// v11.0 — Data-driven tuning from diagnostic pipeline (71k graded props, 119 game days):
//   1. Weights: trend halved (anti-correlated AUC 0.490), restDays dropped to 0.01 (p=0.279)
//      Freed weight redistributed to last20HitRate (60%) and homeAway (40%). All sets sum 1.00.
//   2. Over bias: stat-specific (steals -7, blocks -6, reb/ast/pra -4, pts/3PM -3)
//   3. LOCK thresholds raised: 3PM 72→76, assists 74→78, blocks 74→78. Base LOCK 72→74.
//   4. PLAY thresholds raised: 3PM 66→70, assists 68→72, blocks 72→74. Base PLAY 66→68.
```

- [ ] **Step 2: Update line 15 (trend weight description)**

Replace:

```typescript
//   4.  trend          (12%) — L5 vs L20 momentum (90-day window)
```

With:

```typescript
//   4.  trend          (1-7%) — L5 vs L20 momentum (90-day window) — reduced in v11 (anti-correlated)
```

- [ ] **Step 3: Update line 19 (restDays weight description)**

Replace:

```typescript
//   8.  restDays       ( 5%) — back-to-back fatigue; well-rested boost
```

With:

```typescript
//   8.  restDays       ( 1%) — back-to-back fatigue (demoted in v11: no significant correlation)
```

- [ ] **Step 4: Update line 29 (overBiasAdj description)**

Replace:

```typescript
//   - overBiasAdj:            −3 pts for all OVER props. Empirical data shows OVERs hit 43%
//                               vs UNDERs at 50% — books systematically price OVERs above fair value.
```

With:

```typescript
//   - overBiasAdj:            −3 to −7 pts for OVER props (stat-specific in v11).
//                               Steals −7, blocks −6, reb/ast/pra −4, pts/3PM −3.
```

- [ ] **Step 5: Update line 44 (LOCK threshold description)**

Replace:

```typescript
// LOCK threshold: 68 (stat-specific: assists/pra ≥74, steals/blocks/3PM ≥72).
```

With:

```typescript
// LOCK threshold: base 74 (stat-specific: assists/pra/steals/blocks ≥78, 3PM ≥76, rebounds ≥74).
```

- [ ] **Step 6: Commit**

```bash
git add lib/confidence.ts
git commit -m "docs(confidence): update header to v11.0 with changelog"
```

- [ ] **Step 7: Run diagnostic pipeline to validate**

Run: `python scripts/model_diagnostic.py`

Check the output for:
- LOCK accuracy should increase (fewer LOCKs, higher quality)
- The `trend` anti-correlation flag should weaken
- Over/under gap for steals/blocks should narrow in future graded data

Note: The diagnostic reads historical `prop_grades` which were scored with v10. Threshold changes (Fixes 1, 3, 5) will show immediate impact because they reclassify existing scores. Weight changes (Fixes 3, 4) will only show impact on newly scored props.

- [ ] **Step 8: Final commit with spec + plan docs**

```bash
git add docs/superpowers/specs/2026-04-12-confidence-v11-tuning-design.md docs/superpowers/plans/2026-04-12-confidence-v11-tuning.md
git commit -m "docs: add v11 tuning spec and implementation plan"
```
