"""Pipeline step: write yes/no/void results for recent (ET) Kalshi markets.

Default: settles D-1, D-2, D-3 (ET) each run so a missed day catches up (re-PATCH is
idempotent). Optional argv[1] YYYY-MM-DD settles just that date.

Study rows (kalshi_settled) are NOT built here: fetching candles for ~1,700 markets a
night exceeded the pipeline's 15-minute step limit (2026-11-08..11). The PC task
"Prizm Kalshi settled backfill" runs kalshi_backfill.py nightly instead (resumable).
"""
import os, sys
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipeline.env import load_env_local  # noqa: E402
from kalshi_edges.ingest import run_settle  # noqa: E402

CATCH_UP_DAYS = 3


def target_dates(argv, today):
    if len(argv) > 1:
        return [date.fromisoformat(argv[1])]
    return [today - timedelta(days=k) for k in range(1, CATCH_UP_DAYS + 1)]


if __name__ == '__main__':
    load_env_local()
    dates = target_dates(sys.argv, datetime.now(ZoneInfo('America/New_York')).date())
    for d, n in sorted(run_settle(dates).items()):
        print(f'kalshi_settle {d}: settled {n} markets')
