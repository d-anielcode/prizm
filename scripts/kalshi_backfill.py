"""One-time (resumable) backfill of settled Kalshi player-prop markets with pre-tip prices.
Usage: python kalshi_backfill.py [SERIES ...] [--live-only]"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipeline.env import load_env_local  # noqa: E402
from kalshi_edges.history import backfill  # noqa: E402

if __name__ == '__main__':
    load_env_local()
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    sources = ('live',) if '--live-only' in sys.argv else ('historical', 'live')
    total = backfill(args or None, sources=sources, log=lambda m: print(m, flush=True))
    print(f'kalshi_backfill done: {total}')
