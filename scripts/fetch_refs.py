"""
NBA referee assignment fetcher.

NOT YET WIRED INTO PRODUCTION. This is a starting scaffold for an off-season
project — ingest referee crew data daily ~24h before tip so the confidence
engine can adjust scores by crew tendency (whistle-happy refs boost PTS/PRA
via free throws; slower-paced refs depress all volume props).

Plan (see lib/referee.ts for full design):

  1. This script: poll basketball-reference.com box-score pages for the slate's
     games and parse the "Officials:" footer. Run as a cron after games tip
     (post-game ingestion is more reliable than the league's pre-game page).
     Off-season this script idles since there are no games.

  2. scripts/build_ref_stats.py (TODO): aggregate per-ref calls per game,
     compute fouls/fts/pace averages over rolling 30-day window. Compare to
     league average to produce ref deltas.

  3. lib/referee.ts:refereeAdjustment() consumes the deltas and produces a
     ±3pt scoring adjustment per prop.

Usage (when fully implemented):
    py scripts/fetch_refs.py --date 2026-05-13
    py scripts/fetch_refs.py --backfill --start 2026-04-01

For tonight: prints what it would fetch but doesn't write to DB. Schema is
in lib/referee.ts comments — run those CREATE TABLE statements first when
ready to start collecting.
"""

import argparse
import os
import re
import sys
import time
from datetime import datetime, timedelta
from urllib.parse import urljoin

import requests
from html.parser import HTMLParser


BR_BASE = "https://www.basketball-reference.com"
USER_AGENT = "Mozilla/5.0 (compatible; PrizmRefBot/0.1; +https://prizmproject.vercel.app)"


def parse_args():
    p = argparse.ArgumentParser(description="Fetch NBA referee crew assignments")
    p.add_argument("--date", help="YYYY-MM-DD slate to fetch (default: yesterday ET)")
    p.add_argument("--backfill", action="store_true", help="Backfill from --start to --date inclusive")
    p.add_argument("--start", help="Start date for backfill (YYYY-MM-DD)")
    p.add_argument("--write", action="store_true", help="Write to Supabase (default: dry-run)")
    return p.parse_args()


def fetch_box_score_index(date_str: str) -> list[str]:
    """Return the list of box-score URLs for the given game date."""
    y, m, d = date_str.split("-")
    url = f"{BR_BASE}/boxscores/?month={int(m)}&day={int(d)}&year={int(y)}"
    r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=15)
    if r.status_code == 429:
        print(f"  [refs] rate-limited fetching {date_str}, waiting 30s")
        time.sleep(30)
        r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=15)
    r.raise_for_status()
    html = r.text
    # The index page links each game with "/boxscores/<yyyymmdd0XXX>.html"
    return list(set(re.findall(r"/boxscores/(\d{8}0[A-Z]{3})\.html", html)))


def fetch_refs_for_game(game_id: str) -> list[str]:
    """Return the referee crew names for one game id (e.g. 202405130OKC)."""
    url = f"{BR_BASE}/boxscores/{game_id}.html"
    r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=15)
    if r.status_code == 429:
        time.sleep(30)
        r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=15)
    if r.status_code != 200:
        return []
    html = r.text
    # The officials block appears as "Officials: <a>Name1</a>, <a>Name2</a>, <a>Name3</a>"
    m = re.search(r"Officials:\s*</strong>([^<]*(?:<[^>]+>[^<]*)*)", html)
    if not m:
        return []
    block = m.group(1)
    names = re.findall(r"<a[^>]*>([^<]+)</a>", block)
    return [n.strip() for n in names if n.strip()]


def main():
    args = parse_args()

    if args.date is None:
        # Default: yesterday in ET (games finished, refs published)
        ymd = (datetime.utcnow() - timedelta(days=1)).strftime("%Y-%m-%d")
    else:
        ymd = args.date

    if args.backfill:
        if not args.start:
            print("--backfill requires --start YYYY-MM-DD")
            sys.exit(1)
        start = datetime.strptime(args.start, "%Y-%m-%d")
        end   = datetime.strptime(ymd, "%Y-%m-%d")
        dates = [(start + timedelta(days=i)).strftime("%Y-%m-%d") for i in range((end - start).days + 1)]
    else:
        dates = [ymd]

    total = 0
    for d in dates:
        try:
            game_ids = fetch_box_score_index(d)
        except Exception as e:
            print(f"[refs] {d}: index fetch failed - {e}")
            continue
        print(f"[refs] {d}: {len(game_ids)} games")
        for gid in game_ids:
            try:
                refs = fetch_refs_for_game(gid)
            except Exception as e:
                print(f"  {gid}: fetch failed - {e}")
                continue
            if refs:
                print(f"  {gid}: {', '.join(refs)}")
                total += 1
            else:
                print(f"  {gid}: refs not found")
            time.sleep(2.0)  # be polite to basketball-reference

    print()
    print(f"Done. {total} games with ref data across {len(dates)} date(s).")
    if not args.write:
        print("(Dry run — re-run with --write to upsert to Supabase. Schema in lib/referee.ts comments.)")


if __name__ == "__main__":
    main()
