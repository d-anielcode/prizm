"""Synthetic Kalshi /markets rows for parser tests.

Mirrors the documented Kalshi market schema. Task 7 reconciles the title format
against a live response and adjusts market_data constants if needed.
"""
def sample_markets():
    return [
        {"ticker": "KXNBAPTS-LBJ-30", "title": "LeBron James to score 30+ points",
         "subtitle": "", "yes_bid": 38, "yes_ask": 42, "volume": 1200, "status": "open"},
        {"ticker": "KXNBAREB-NJ-15", "title": "Will Nikola Jokic record 15+ rebounds?",
         "subtitle": "", "yes_bid": 28, "yes_ask": 33, "volume": 800, "status": "open"},
        {"ticker": "KXNBA3PM-SC-5", "title": "Stephen Curry to make 5+ three-pointers",
         "subtitle": "", "yes_bid": 45, "yes_ask": 49, "volume": 1500, "status": "open"},
        {"ticker": "KXECON-CPI", "title": "CPI above 3% in June",
         "subtitle": "", "yes_bid": 50, "yes_ask": 55, "volume": 999, "status": "open"},
    ]
