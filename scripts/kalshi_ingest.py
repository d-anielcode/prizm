"""Pipeline step: upsert today's open Kalshi NBA player-prop markets into kalshi_markets."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipeline.env import load_env_local  # noqa: E402
from kalshi_edges.ingest import run_ingest  # noqa: E402

if __name__ == '__main__':
    load_env_local()
    n, skipped = run_ingest()
    print(f'kalshi_ingest: upserted {n} markets, skipped {skipped}')
    sys.exit(0 if n > 0 or skipped == 0 else 1)
