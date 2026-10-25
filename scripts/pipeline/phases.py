from pipeline.steps import Step

R, S = 'results', 'slate'

PHASES = {
    'overnight': [
        Step('gamelogs', R, 'http', '/api/gamelogs?days=3', -1, critical=True),
        Step('grade', R, 'http', '/api/grade', -1, critical=True, readiness='logs_ready'),
        Step('grade_wnba', R, 'http', '/api/grade/wnba', -1, skip_if='wnba_offseason'),
        Step('feed_grade', R, 'http', '/api/feed/grade', -1),
        Step('results', R, 'http', '/api/results?force=true', -1, coverage='results_present'),
        Step('seasonstats', R, 'http', '/api/seasonstats', -1),
        Step('perf_snapshot', R, 'http', '/api/performance-snapshot', -1),
        Step('props', S, 'http', '/api/props?refresh=true', 0, critical=True),
        Step('props_wnba', S, 'http', '/api/props/wnba?refresh=true', 0, skip_if='wnba_offseason'),
        Step('wnba_stats', S, 'python', 'fetch_wnba_stats.py', 0, skip_if='wnba_offseason'),
        Step('sim_3pm', S, 'python', 'sim_3pm.py', 0),
        Step('enrich', S, 'http', '/api/enrich?force=true', 0, critical=True, coverage='enrich_coverage'),
        Step('streak', S, 'http', '/api/feed/generate/streak', 0),
        Step('parlay', S, 'http', '/api/feed/generate/parlay', 0),
        Step('defense_fresh', 'checks', 'check', 'defense_fresh', 0),
    ],
    'midday': [
        Step('props', S, 'http', '/api/props?refresh=true', 0, critical=True),
        Step('enrich', S, 'http', '/api/enrich?force=true', 0, critical=True, coverage='enrich_coverage'),
        Step('parlay_pass2', S, 'http', '/api/feed/generate/parlay?pass=2', 0),
    ],
    'pretip': [
        Step('lineups', S, 'http', '/api/lineups/fetch', 0),
        Step('props', S, 'http', '/api/props?refresh=true', 0, critical=True),
        Step('enrich', S, 'http', '/api/enrich?force=true', 0, critical=True, coverage='enrich_coverage'),
        Step('snapshot', S, 'http', '/api/props/snapshot', 0),
    ],
    'weekly': [
        Step('player_bias', 'weekly', 'http', '/api/player-bias?action=analyze', 0),
        Step('opponent_leaks', 'weekly', 'http', '/api/opponent-leaks?action=analyze', 0),
    ],
}
