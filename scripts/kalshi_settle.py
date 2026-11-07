"""Pipeline step: write yes/no results for yesterday's (ET) Kalshi markets."""
import os, sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipeline.env import load_env_local  # noqa: E402
from kalshi_edges.ingest import run_settle  # noqa: E402

if __name__ == '__main__':
    load_env_local()
    d = datetime.now(ZoneInfo('America/New_York')).date() - timedelta(days=1)
    print(f'kalshi_settle {d}: settled {run_settle(d)} markets')
