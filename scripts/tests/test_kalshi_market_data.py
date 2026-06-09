from kalshi_edges.market_data import parse_market, KalshiProp
from tests.fixtures.kalshi_markets import sample_markets

def test_parse_points_market():
    kp = parse_market(sample_markets()[0])
    assert kp == KalshiProp("KXNBAPTS-LBJ-30", "LeBron James", "points", 30, 0.38, 0.42, 1200)

def test_parse_rebounds_strips_will_and_question():
    kp = parse_market(sample_markets()[1])
    assert kp.player == "Nikola Jokic"
    assert kp.stat == "rebounds"
    assert kp.strike == 15

def test_parse_three_pointers():
    kp = parse_market(sample_markets()[2])
    assert kp.stat == "three_pointers"
    assert kp.strike == 5
    assert kp.yes_ask == 0.49

def test_parse_non_prop_returns_none():
    assert parse_market(sample_markets()[3]) is None
