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
            # +epsilon so an exact-boundary curve value (e.g. 60.00) clears a
            # target that float arithmetic inflates (0.60 * 100 = 60.000...01).
            if lookup[raw] + 1e-9 >= target_pct:
                threshold = raw
                break
        out[tier] = threshold
    return out
