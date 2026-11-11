from kalshi_edges.teams import canon, spellings, ticker_teams

def test_canon_maps_espn_and_variants():
    assert canon("NY") == "NYK" and canon("SA") == "SAS" and canon("GS") == "GSW"
    assert canon("UTAH") == "UTA" and canon("WSH") == "WAS" and canon("NO") == "NOP"
    assert canon("bos") == "BOS"

def test_spellings_include_canonical_and_aliases():
    s = spellings("NY")
    assert {"NY", "NYK"} <= s

def test_ticker_teams():
    assert ticker_teams("KXNBAPTS-26JUN13NYKSAS-SASVWEMBANYAMA1-40") == "NYKSAS"
    assert ticker_teams("BAD") is None
