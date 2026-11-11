"""Load the repo's .env.local into os.environ (without overriding real env vars)."""
import os

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))


def load_env_local(path=None):
    path = path or os.path.join(REPO, '.env.local')
    if not os.path.exists(path):
        return
    with open(path, encoding='utf-8') as fh:
        for line in fh:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
