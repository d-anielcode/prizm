from kalshi_edges import sb

class FakeResp:
    def __init__(self, data): self._d = data; self.status_code = 200
    def raise_for_status(self): pass
    def json(self): return self._d

def test_select_all_pages_until_short(monkeypatch):
    monkeypatch.setattr(sb, "_sb", lambda: ("U", {}))
    pages = [[{"i": i} for i in range(1000)], [{"i": 1000}]]
    calls = []
    def get(url, headers=None, timeout=None):
        calls.append(headers["Range"]); return FakeResp(pages[len(calls) - 1])
    monkeypatch.setattr(sb.requests, "get", get)
    rows = sb.select_all("t", "select=i&order=i")
    assert len(rows) == 1001 and calls == ["0-999", "1000-1999"]
