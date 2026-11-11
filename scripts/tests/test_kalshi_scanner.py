from datetime import date, datetime, timezone
import pytest
from kalshi_edges.market_data import KalshiProp
from kalshi_edges.fair_value import FairLine
from kalshi_edges.prob_model import Distribution
from kalshi_edges.scanner import Filters, evaluate_rung, scan
from kalshi_edges.fees import taker_fee

NOW = datetime(2026, 10, 21, 20, 0, tzinfo=timezone.utc)
TIP = "2026-10-21T23:00:00+00:00"
DIST = Distribution("normal", 25.0, 6.0, None)

def kp(strike=25, bid=0.30, ask=0.36, stat="points"):
    return KalshiProp(f"KXNBAPTS-26OCT21PHXPOR-X-{strike}", "Damian Lillard", stat, strike, bid, ask, 10,
                      series="KXNBAPTS", game_date=date(2026, 10, 21), away="PHX", home="POR")

def fair(p_over=0.55, line=24.5, t=TIP):
    return FairLine("Damian Lillard", "points", line, p_over, "two_sided", "DraftKings", t)

def test_yes_edge_after_fee():
    c = evaluate_rung(kp(ask=0.40, bid=0.35), fair(), DIST, 1.0, NOW, Filters(min_edge=-1))
    assert c.side == "yes"
    assert c.edge == pytest.approx(c.fair_p - 0.40 - taker_fee(0.40), abs=1e-4)

def test_no_side_when_yes_is_rich():
    c = evaluate_rung(kp(ask=0.80, bid=0.75), fair(), DIST, 1.0, NOW, Filters(min_edge=-1))
    assert c.side == "no"
    assert c.price == pytest.approx(0.25)
    assert c.edge == pytest.approx(c.fair_p - 0.25 - taker_fee(0.25), abs=1e-4)

def test_min_edge_filters():
    # YES: 0.55 - 0.52 - fee(0.52) = 0.0125 < 0.03; NO: 0.45 - 0.53 - fee < 0
    assert evaluate_rung(kp(ask=0.52, bid=0.47), fair(), DIST, 1.0, NOW, Filters()) is None

def test_wide_spread_filtered():
    assert evaluate_rung(kp(ask=0.30, bid=0.05), fair(), DIST, 1.0, NOW, Filters(min_edge=-1)) is None

def test_started_game_filtered():
    late = datetime(2026, 10, 21, 23, 5, tzinfo=timezone.utc)
    assert evaluate_rung(kp(ask=0.30, bid=0.26), fair(), DIST, 1.0, late, Filters(min_edge=-1)) is None

def test_far_strike_filtered():
    assert evaluate_rung(kp(strike=40, ask=0.02, bid=0.01), fair(), DIST, 1.0, NOW, Filters(min_edge=-1)) is None

def test_extreme_probability_filtered():
    assert evaluate_rung(kp(strike=12, ask=0.90, bid=0.88), fair(line=11.5, p_over=0.97),
                         DIST, 1.0, NOW, Filters(min_edge=-1, max_rungs=10)) is None

def test_scan_matches_names_and_counts_skips():
    logs = {"damian lillard": [{"points": v, "minutes": 34} for v in (20, 22, 24, 25, 26, 28, 30, 31, 19, 27, 25, 23)]}
    cands, skipped = scan([kp(ask=0.30, bid=0.26), kp(stat="rebounds")],
                          {("damian lillard", "points"): fair()}, logs, {"KXNBAPTS": 1.0}, NOW,
                          Filters(min_edge=-1))
    assert len(cands) == 1 and cands[0].market_ticker.endswith("-25")
    assert skipped["no_book_line"] == 1


def test_one_sided_fair_value_filtered():
    one = FairLine("Damian Lillard", "points", 24.5, 0.55, "one_sided", "DraftKings", TIP)
    assert evaluate_rung(kp(ask=0.30, bid=0.26), one, DIST, 1.0, NOW, Filters(min_edge=-1)) is None

def test_rungs_beyond_one_step_filtered():
    # book over 24.5 <-> Kalshi 25+ is the at-line rung; 26+ is 1 away, 27+ is 2 away
    assert evaluate_rung(kp(strike=26, ask=0.30, bid=0.26), fair(), DIST, 1.0, NOW, Filters(min_edge=-1)) is not None
    assert evaluate_rung(kp(strike=27, ask=0.20, bid=0.16), fair(), DIST, 1.0, NOW, Filters(min_edge=-1)) is None
