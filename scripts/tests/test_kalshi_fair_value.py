import pytest
from kalshi_edges.fair_value import american_to_prob, fair_lines, ONE_SIDED_VIG, OVER_BIAS

def row(name, d, line, odds, book="DraftKings", stat="points", t="2026-10-21T23:00:00+00:00"):
    return {"player_name": name, "stat_type": stat, "direction": d, "line": line,
            "odds": odds, "sportsbook": book, "commence_time": t}

def test_american_to_prob():
    assert american_to_prob(-110) == pytest.approx(110 / 210)
    assert american_to_prob(150) == pytest.approx(0.4)

def test_american_to_prob_rejects_insane():
    for o in (None, 3000, -10000, 50):
        assert american_to_prob(o) is None

def test_two_sided_devig_sums_to_one():
    fl, amb = fair_lines([row("Jayson Tatum", "over", 26.5, -110), row("Jayson Tatum", "under", 26.5, -110)])
    f = fl[("jayson tatum", "points")]
    assert f.p_over == pytest.approx(0.5 - OVER_BIAS)
    assert f.devig == "two_sided" and f.line == 26.5 and f.books == "DraftKings"
    assert amb == set()

def test_two_sided_skewed():
    fl, _ = fair_lines([row("A B", "over", 5.5, -150), row("A B", "under", 5.5, 120)])
    po, pu = 150 / 250, 100 / 220
    assert fl[("a b", "points")].p_over == pytest.approx(po / (po + pu) - OVER_BIAS)

def test_one_sided_over_subtracts_half_vig():
    fl, _ = fair_lines([row("A B", "over", 5.5, -120)])
    f = fl[("a b", "points")]
    assert f.devig == "one_sided"
    assert f.p_over == pytest.approx(120 / 220 - ONE_SIDED_VIG - OVER_BIAS)

def test_one_sided_under_is_inverted():
    fl, _ = fair_lines([row("A B", "under", 5.5, -120)])
    assert fl[("a b", "points")].p_over == pytest.approx(1 - (120 / 220 - ONE_SIDED_VIG) - OVER_BIAS)

def test_mismatched_lines_fall_back_to_one_sided_over():
    fl, _ = fair_lines([row("A B", "over", 5.5, -110), row("A B", "under", 6.5, -110)])
    f = fl[("a b", "points")]
    assert f.devig == "one_sided" and f.line == 5.5

def test_spelling_variants_merge_into_one_player():
    fl, amb = fair_lines([row("Nikola Jokic", "over", 11.5, -110, stat="rebounds"),
                          row("Nikola Jokić", "under", 11.5, -110, stat="rebounds")])
    assert fl[("nikola jokic", "rebounds")].devig == "two_sided"
    assert amb == set()


def test_over_bias_matches_measured_value():
    # 66.6k paired DK/FD/Fanatics/Caesars lines with outcomes (Dec 2025-Mar 2026):
    # proportional de-vig overstated P(over) by 1.93 pts (Dec-Feb) and 1.59 pts (Mar).
    assert OVER_BIAS == pytest.approx(0.018)
