"""One-time (resumable) backfill of settled Kalshi player-prop markets with pre-tip prices.
Usage: python kalshi_backfill.py [SERIES ...] [--live-only] [--log PATH]
--log appends all output to PATH (for the windowless pythonw scheduled task)."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipeline.env import load_env_local  # noqa: E402
from kalshi_edges.history import backfill  # noqa: E402

if __name__ == '__main__':
    if '--log' in sys.argv:
        path = sys.argv[sys.argv.index('--log') + 1]
        sys.stdout = sys.stderr = open(path, 'a', encoding='utf-8', buffering=1)
    load_env_local()
    skip = {sys.argv.index('--log') + 1} if '--log' in sys.argv else set()
    args = [a for i, a in enumerate(sys.argv[1:], 1) if not a.startswith('--') and i not in skip]
    sources = ('live',) if '--live-only' in sys.argv else ('historical', 'live')
    total = backfill(args or None, sources=sources, log=lambda m: print(m, flush=True))
    print(f'kalshi_backfill done: {total}')
