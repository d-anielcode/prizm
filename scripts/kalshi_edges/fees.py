"""Kalshi taker fee. NBA player-prop series report fee_type='quadratic',
fee_multiplier=1 (verified 2026-10-21): fee = 0.07 * m * p * (1 - p) per contract.
Kalshi rounds the ORDER total up to the cent; we use the unrounded per-contract
value, which matches real orders of 10+ contracts."""
import requests
from kalshi_edges.market_data import KALSHI_BASE

FEE_RATE = 0.07

def taker_fee(price, multiplier=1.0):
    if not 0.0 <= price <= 1.0:
        raise ValueError(f"price out of range: {price}")
    return FEE_RATE * multiplier * price * (1.0 - price)

def fetch_fee_multiplier(series_ticker, session=None):
    """The series' fee_multiplier (defaults to 1.0 if absent)."""
    sess = session or requests.Session()
    r = sess.get(f"{KALSHI_BASE}/series/{series_ticker}", timeout=30)
    r.raise_for_status()
    s = r.json().get("series", {})
    return float(s.get("fee_multiplier") or 1.0)
