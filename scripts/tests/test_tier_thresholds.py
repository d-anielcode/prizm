from tier_thresholds import derive_tier_thresholds, DEFAULT_TARGETS

def _curve(points):
    """Build a 101-length monotonic non-decreasing calibrated-percent lookup.
    points: {raw_score: calibrated_pct} dict; value held until the next point.
    (Passed positionally, not **-unpacked: Python 3.14 forbids int kwarg keys.)"""
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
