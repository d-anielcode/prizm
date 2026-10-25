"""python -m pipeline <overnight|midday|pretip|weekly> [--date YYYY-MM-DD] [--dry-run]"""
import argparse
import os
import subprocess
import sys
from datetime import datetime, timezone

from pipeline.http import VercelClient
from pipeline.phases import PHASES
from pipeline.runner import run_phase
from pipeline.store import NullStore, Store

SCRIPTS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_python(script):
    return subprocess.run([sys.executable, os.path.join(SCRIPTS, script)], cwd=SCRIPTS, timeout=900).returncode


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('phase', choices=sorted(PHASES))
    ap.add_argument('--date')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args(argv)
    store = NullStore() if a.dry_run else Store()
    http = None if a.dry_run else VercelClient()
    return run_phase(a.phase, now=datetime.now(timezone.utc), http=http, store=store,
                     python=run_python, dry_run=a.dry_run, game_date=a.date)


if __name__ == '__main__':
    sys.exit(main())
