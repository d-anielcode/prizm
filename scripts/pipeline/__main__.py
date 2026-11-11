"""python -m pipeline <overnight|midday|pretip|kalshi_live|weekly> [--date YYYY-MM-DD] [--dry-run]"""
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


STEP_TIMEOUT_S = 900
TIMEOUT_EXIT = 124


def run_python(script):
    """Run a scripts/ step. A timeout fails that step (exit 124) instead of crashing the
    whole phase: an uncaught TimeoutExpired on 2026-11-08..11 killed every overnight run
    after kalshi_settle and left its job_runs row stuck at 'running'."""
    try:
        return subprocess.run([sys.executable, os.path.join(SCRIPTS, script)], cwd=SCRIPTS,
                              timeout=STEP_TIMEOUT_S).returncode
    except subprocess.TimeoutExpired:
        print(f'[pipeline] {script} timed out after {STEP_TIMEOUT_S}s', flush=True)
        return TIMEOUT_EXIT


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
