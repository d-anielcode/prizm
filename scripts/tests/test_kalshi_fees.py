import pytest
from kalshi_edges.fees import taker_fee

def test_quadratic_fee_at_50c():
    assert taker_fee(0.50) == pytest.approx(0.0175)

def test_fee_symmetric_and_small_at_extremes():
    assert taker_fee(0.20) == pytest.approx(taker_fee(0.80))
    assert taker_fee(0.05) == pytest.approx(0.07 * 0.05 * 0.95)

def test_fee_multiplier_scales():
    assert taker_fee(0.50, multiplier=0.5) == pytest.approx(0.00875)

def test_fee_rejects_out_of_range_price():
    with pytest.raises(ValueError):
        taker_fee(1.2)
