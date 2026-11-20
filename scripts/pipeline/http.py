import os
import requests


class VercelClient:
    """GET a Prizm API route with the cron secret. Returns (status, json_or_None).
    Raises on connection errors/timeouts so the runner can retry."""

    def __init__(self, base=None, secret=None, timeout=300):
        self.base = (base or os.environ['VERCEL_APP_URL']).rstrip('/')
        self.h = {'Authorization': f"Bearer {secret or os.environ['CRON_SECRET']}"}
        self.timeout = timeout

    def get(self, path):
        r = requests.get(self.base + path, headers=self.h, timeout=self.timeout)
        try:
            body = r.json()
        except ValueError:
            body = {'text': r.text[:500]}
        return r.status_code, body
