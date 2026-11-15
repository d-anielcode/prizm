"""Run the full-ladder replay on 2025-26 (spec 2026-11-11). PC only, once, after the
kalshi_settled backfill covers all 5 ladder stats and the strike-fix SQL has run.
Usage: python kalshi_ladder_replay.py [--report]
  --report writes docs/kalshi-study/<date>-full-ladder-replay.{md,json} (commit them by hand)."""
import json, os, sys
from dataclasses import asdict
from datetime import date
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipeline.env import load_env_local  # noqa: E402
from kalshi_edges import sb  # noqa: E402
from kalshi_edges.ladder_model import LADDER_STATS  # noqa: E402
from kalshi_edges.ladder_replay import SEASON, render_report, replay, replay_complete, summarize  # noqa: E402
from kalshi_edges.prizm_data import load_calibration  # noqa: E402

SETTLED_COLS = "ticker,player,stat,strike,game_date,season,pretip_yes_bid,pretip_yes_ask,result"
GRADE_COLS = "game_date,player_name,stat_type,line,direction,confidence_score"
LOG_COLS = "player_name,game_date,minutes,points,rebounds,assists,fg3m,pra"

if __name__ == '__main__':
    load_env_local()
    stats = ",".join(LADDER_STATS)
    settled = sb.select_all("kalshi_settled", f"select={SETTLED_COLS}&season=eq.{SEASON}&stat=in.({stats})&order=ticker")
    ok, reason = replay_complete(settled)
    if not ok:
        print(f"kalshi_ladder_replay: backfill incomplete ({reason})"); sys.exit(1)
    lo = min(str(r["game_date"])[:10] for r in settled)
    hi = max(str(r["game_date"])[:10] for r in settled)
    grades = sb.select_all("prop_grades", f"select={GRADE_COLS}&game_date=gte.{lo}&game_date=lte.{hi}"
                                          f"&stat_type=in.({stats})&confidence_score=not.is.null&order=id")
    logs = sb.select_all("player_game_logs", f"select={LOG_COLS}&game_date=gte.2024-10-01&game_date=lte.{hi}&order=id")
    print(f"kalshi_ladder_replay: {len(settled)} settled rungs, {len(grades)} graded lines, {len(logs)} logs")
    out = replay(settled, grades, logs, load_calibration())
    s = summarize(out, len(settled))
    v = s["verdict"]
    print(f"result: {'PASS' if v['pass'] else 'FAIL'} n={v['n']} roi={v['roi']:+.4f} "
          f"h1={v['roi_h1']:+.4f} h2={v['roi_h2']:+.4f} p={v['p']:.4f}; skips {s['skips']}")
    if '--report' in sys.argv:
        d = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'docs', 'kalshi-study')
        os.makedirs(d, exist_ok=True)
        stem = os.path.join(d, f"{date.today().isoformat()}-full-ladder-replay")
        with open(stem + '.md', 'w', encoding='utf-8') as f:
            f.write(render_report(s))
        with open(stem + '.json', 'w', encoding='utf-8') as f:
            json.dump({**s, "trades": [asdict(t) for t in out["trades"]]}, f, indent=1, default=str)
        print(f"report: {stem}.md")
