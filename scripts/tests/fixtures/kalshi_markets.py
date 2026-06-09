"""Kalshi /markets rows for parser tests, in the REAL schema verified live on
2026-06-08: prices are decimal strings in `*_dollars`, volume in `volume_fp`, and
the milestone strike is the structured `floor_strike` (+ `strike_type`).

NOTE: the single-game prop *title* format ("Will <Player> <verb> <n>+ <stat>?")
is still a best-guess pending live confirmation on an NBA game day; the price /
volume / strike fields are confirmed.
"""
def sample_markets():
    return [
        {"ticker": "KXNBAPTSLEBRON-26JUN08-30", "title": "Will LeBron James score 30+ points?",
         "yes_sub_title": "30+ points", "strike_type": "greater_or_equal",
         "floor_strike": 30, "cap_strike": None,
         "yes_ask_dollars": "0.4200", "yes_bid_dollars": "0.3800",
         "volume_fp": "1200.00", "status": "active"},
        {"ticker": "KXNBAREBJOKIC-26JUN08-15", "title": "Will Nikola Jokic record 15+ rebounds?",
         "yes_sub_title": "15+ rebounds", "strike_type": "greater_or_equal",
         "floor_strike": 15, "cap_strike": None,
         "yes_ask_dollars": "0.3300", "yes_bid_dollars": "0.2800",
         "volume_fp": "800.00", "status": "active"},
        {"ticker": "KXNBA3PMCURRY-26JUN08-5", "title": "Will Stephen Curry make 5+ three-pointers?",
         "yes_sub_title": "5+ three-pointers", "strike_type": "greater_or_equal",
         "floor_strike": 5, "cap_strike": None,
         "yes_ask_dollars": "0.4900", "yes_bid_dollars": "0.4500",
         "volume_fp": "1500.00", "status": "active"},
        {"ticker": "KXCPI-26JUN", "title": "CPI above 3% in June",
         "yes_sub_title": "Above 3%", "strike_type": "greater",
         "floor_strike": None, "cap_strike": None,
         "yes_ask_dollars": "0.5500", "yes_bid_dollars": "0.5000",
         "volume_fp": "999.00", "status": "active"},
    ]
