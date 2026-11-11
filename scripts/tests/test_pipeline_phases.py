from pipeline.phases import PHASES

def names(phase):
    return [s.name for s in PHASES[phase]]

def test_overnight_order():
    assert names('overnight') == [
        'gamelogs', 'grade', 'grade_wnba', 'feed_grade', 'results', 'seasonstats', 'perf_snapshot',
        'props', 'props_wnba', 'wnba_stats', 'sim_3pm', 'enrich', 'streak', 'parlay',
        'kalshi_settle', 'kalshi_pocket_grade', 'kalshi_model_grade', 'defense_fresh']

def test_chains_and_dates():
    by = {s.name: s for s in PHASES['overnight']}
    assert {by[n].chain for n in ('gamelogs', 'grade', 'results', 'perf_snapshot')} == {'results'}
    assert by['gamelogs'].date_offset == -1 and by['props'].date_offset == 0
    assert by['grade'].readiness == 'logs_ready'
    assert by['results'].coverage == 'results_present'
    assert by['enrich'].coverage == 'enrich_coverage'

def test_critical_steps():
    crit = {s.name for p in PHASES.values() for s in p if s.critical}
    assert crit == {'gamelogs', 'grade', 'props', 'enrich'}

def test_other_phases():
    assert names('midday') == ['props', 'enrich', 'parlay_pass2', 'kalshi_ingest']
    assert names('pretip') == ['lineups', 'props', 'enrich', 'snapshot', 'kalshi_ingest']
    assert names('kalshi_live') == ['kalshi_ingest', 'kalshi_model_log', 'kalshi_pocket_scan']
    assert names('weekly') == ['player_bias', 'opponent_leaks', 'kalshi_study']

def test_kalshi_steps_own_chain_not_critical():
    ks = [s for p in PHASES.values() for s in p if s.name.startswith('kalshi_')]
    assert len(ks) == 9
    assert all(s.chain == 'kalshi' and not s.critical for s in ks)
    assert {s.name for s in ks if s.kind != 'python'} == {'kalshi_model_log'}
    log = next(s for s in PHASES['kalshi_live'] if s.name == 'kalshi_model_log')
    assert log.kind == 'http' and log.target == '/api/markets/model-picks/log'
