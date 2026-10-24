# Calibration-Honest Tiers — Design

**Date:** 2026-06-20
**Status:** Approved (design phase)
**Scope:** Offseason model overhaul, piece 1 of the planned sequence (this, then a WNBA pivot).

## Problem

The full-season diagnostic (86.6k graded props, Dec 2025 → playoffs) shows:

- **Weights are at the linear ceiling.** LogReg val AUC 0.5584 vs the current
  weighted-score AUC 0.5494 — gap **+0.009**. Retraining a "v12" weight set is
  empirically dead-on-arrival (also found in May). So the overhaul is NOT about weights.
- **Line selection is already solved.** Best-line / line-shopping dedup shipped
  2026-05-05 (`lib/dedup.ts`), live since the May 23 prod build. The diagnostic's
  +12pp best-vs-worst-line gap is a historical artifact from pre-fix props.
- **Scores are overconfident above ~55.** Raw 70–75 implies ~72% but actual ~59%;
  80–85 implies ~82% vs ~67%. The isotonic calibration table corrects *displayed*
  probabilities, but **LOCK/PLAY/LEAN tiers still gate on raw scores** — so a "LOCK"
  doesn't deliver what it claims (LOCK tiers ran 48–74% on tiny samples, not 65%+).

So the one clear, evidence-backed model win is **honest tiers**: make the tier a
function of calibrated probability, not an inflated raw score.

## Decisions (locked during brainstorming)

1. **Approach B — calibration-*derived* raw thresholds**, not tiering directly on
   calibrated probability. Keep tiering/sorting/dedup on raw scores (preserves
   top-tier resolution that the isotonic plateaus would otherwise collapse), but
   *set* each stat's raw threshold to the lowest raw score whose calibrated
   hit-rate clears a target.
2. **Remove the LEAN tier.** At standard −110 juice, breakeven is 52.38%, so a
   LEAN (~52%) is a negative-EV pick — a fake edge. Collapse to **LOCK / PLAY / FADE**
   with **vig-aware** floors so every surfaced pick is genuinely +EV.
3. **Targets (global ladder, per-stat thresholds):** LOCK ≥ **60%**, PLAY ≥ **55%**,
   FADE < 55%. These four are the one product decision; validated/tunable before shipping.
4. **LEAN removal = forward-only deprecation, no data migration.**
5. **No Supabase DDL.** All label/tier columns are plain `text` (verified live:
   `props.confidence_label/risk_tier`, `prop_grades.confidence_label`,
   `prop_history.confidence_label/risk_tier`, `prop_alts.confidence_label`). Historical
   LEAN/MED_RISK rows stay valid text; new scoring stops emitting them. Lossless by construction.

## Architecture & ownership

**`build_calibration.py` owns the thresholds** (it already fits the per-stat isotonic
curves). After fitting, it derives a `tier_thresholds` block and writes it into
`lib/calibration-table.json`, regenerated weekly with the curves:

```json
"tier_thresholds": {
  "_targets": { "lock": 0.60, "play": 0.55 },
  "_global":  { "lock": 78, "play": 73 },
  "rebounds": { "lock": 76, "play": 71 },
  "three_pointers": { "lock": null, "play": 77 }
}
```

Each value is the lowest raw score whose calibrated hit-rate ≥ target; `null` when
the (sample-capped) curve never reaches it — that stat earns no picks at that tier.
Monotonicity (`lock ≥ play`) is automatic (ordered targets + monotone isotonic curve).

**Read path & precedence.** New export `tierThresholds(statType)` in `lib/calibration.ts`
(it already imports the table). `getLabel` in `lib/confidence.ts` gates on these, with
precedence: `calibration-table tier_thresholds` → `confidence-weights.json
lock/play_thresholds` (fallback) → code defaults. A `null` LOCK means "skip LOCK, try PLAY".

**Unify the two labelers.** Today main props use `getLabel` (config thresholds) and alt
lines use `adjAltLabel` in `app/api/enrich/route.ts` (separate hardcoded thresholds) —
a latent drift bug. `adjAltLabel` is **deleted** and replaced by a call to `getLabel`,
so both tier off the same calibration-derived thresholds.

**Retire competing threshold writers.** `auto_retrain.py` currently searches and writes
`lock/play_thresholds` into `confidence-weights.json`. Once calibration-table is
authoritative, that search is disabled (auto_retrain keeps tuning weights/bias; tier
thresholds become calibration's job). Its old threshold output stays as inert fallback.

## `getLabel` after the change

```ts
function getLabel(score, statType): { label, tier } {
  const t = tierThresholds(statType)          // calibration-derived; may be {lock:null,...}
  const lock = t?.lock ?? configLock ?? baseLock
  const play = t?.play ?? configPlay ?? basePlay
  if (lock != null && score >= lock) return { label: 'LOCK', tier: 'PRIME'    }
  if (play != null && score >= play) return { label: 'PLAY', tier: 'LOW_RISK' }
  return                                    { label: 'FADE', tier: 'HIGH_RISK' }
}
```

No LEAN branch. `MED_RISK` risk tier is no longer emitted (kept as a legacy text value).

## LEAN removal scope (forward-only)

- `getLabel` + the unified alt path emit only **LOCK / PLAY / FADE**.
- Keep `'LEAN'` in the `ConfidenceLabel` type as a **legacy** member (annotated
  deprecated), so historical rows and analytics still typecheck and render.
- **Live pick surfaces** drop the LEAN chip/tab: `app/edge/page.tsx`,
  `app/game/[id]/page.tsx`.
- **Historical analytics stay LEAN-tolerant** (they report what happened):
  `app/performance/page.tsx`, `app/trends/page.tsx`, `app/api/performance-snapshot/route.ts`,
  `app/api/backtest/**`. Left unchanged.
- No DB migration; no relabel of historical rows.

## Files touched

- `scripts/build_calibration.py` — derive + emit `tier_thresholds`.
- `lib/calibration.ts` — `tierThresholds(statType)` export + table typing.
- `lib/confidence.ts` — `getLabel` reads calibration thresholds; drop LEAN branch.
- `app/api/enrich/route.ts` — delete `adjAltLabel`, route alt lines through `getLabel`.
- `scripts/auto_retrain.py` — disable threshold search (weights/bias only).
- `types/index.ts` — annotate `'LEAN'` legacy.
- `app/edge/page.tsx`, `app/game/[id]/page.tsx` — drop LEAN chip from live tiers.
- New: `scripts/validate_tier_thresholds.py` — leak-free validation.

## Validation (adoption gate)

`scripts/validate_tier_thresholds.py`:
1. Temporal split: fit isotonic on `game_date < cutoff`, derive thresholds from the
   train fit, then on held-out (`≥ cutoff`) compute each tier's actual hit-rate,
   volume, and EV at −110, per stat and overall.
2. **Adopt only if** held-out LOCK ≥ 60% and PLAY ≥ 55% (within sampling noise) and
   volumes are non-trivial. Otherwise nudge the targets and re-run. Report per-stat
   thresholds incl. `null` tiers explicitly.

Production `tier_thresholds` are then built on all data with the validated targets;
the weekly calibration cron keeps them fresh.

## Testing

- **Python (pytest, `scripts/tests/`):** threshold-derivation unit tests — given a
  known per-stat lookup curve + targets, returns correct thresholds incl. `null` when
  unreachable; monotonic ordering holds.
- **TS (vitest, `lib/__tests__/`):** `getLabel` with stub `tier_thresholds` → correct
  LOCK/PLAY/FADE, never returns LEAN, `null` LOCK falls through to PLAY; main-prop and
  alt-line labels agree (unified labeler).

## Rollout

Merge → rebuild `calibration-table.json` with validated targets → `vercel --prod`
(prod does NOT auto-deploy from push — see feedback memory) → re-enrich the last cached
slate, confirm labels are only LOCK/PLAY/FADE with sane counts.

**Offseason caveat:** no live NBA slate to verify against; validation rests on the
held-out historical data + the re-enrich sanity check. Live exercise comes with the
WNBA pivot / next season.

## Out of scope

- Weight retraining (at ceiling). Line-shopping expansion (already live; more-books
  lever deferred). Under-bias re-tuning (v11.2 already addressed; marginal). Storing a
  `calibrated_prob` column (declined — no DDL). Relabeling historical LEAN rows.
