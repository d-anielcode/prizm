"""Minimal Supabase REST helpers (service role) for the Kalshi study scripts."""
import os
import requests

PAGE = 1000


def _sb():
    url = os.environ["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/") + "/rest/v1"
    key = os.environ["SUPABASE_SERVICE_KEY"]
    return url, {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}


def select_all(table, query):
    """All rows for `table?query`, paged with Range headers. Query must include a unique order."""
    url, h = _sb()
    out, start = [], 0
    while True:
        r = requests.get(f"{url}/{table}?{query}", headers={**h, "Range": f"{start}-{start + PAGE - 1}"}, timeout=60)
        r.raise_for_status()
        rows = r.json()
        out.extend(rows)
        if len(rows) < PAGE:
            return out
        start += PAGE


def upsert(table, rows, on_conflict, page=500):
    url, h = _sb()
    for i in range(0, len(rows), page):
        r = requests.post(f"{url}/{table}?on_conflict={on_conflict}",
                          headers={**h, "Prefer": "resolution=merge-duplicates,return=minimal"},
                          json=rows[i:i + page], timeout=60)
        r.raise_for_status()
    return len(rows)


def insert_ignore(table, rows, on_conflict):
    """Insert, skipping rows that hit the unique key. Returns rows actually inserted."""
    if not rows:
        return 0
    url, h = _sb()
    r = requests.post(f"{url}/{table}?on_conflict={on_conflict}&select=id",
                      headers={**h, "Prefer": "resolution=ignore-duplicates,return=representation"},
                      json=rows, timeout=60)
    r.raise_for_status()
    return len(r.json())


def patch(table, query, fields):
    url, h = _sb()
    r = requests.patch(f"{url}/{table}?{query}", headers={**h, "Prefer": "return=minimal"}, json=fields, timeout=60)
    r.raise_for_status()
