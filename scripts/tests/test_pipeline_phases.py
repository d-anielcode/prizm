from pipeline.phases import PHASES

def names(phase):
    return [s.name for s in PHASES[phase]]

def test_overnight_order():
    assert names('overnight') == [
        'gamelogs', 'grade', 'grade_wnba', 'feed_grade', 'results', 'seasonstats', 'perf_snapshot',
        'props', 'props_wnba', 'wnba_stats', 'sim_3pm', 'enrich', 'streak', 'parlay',
        'defense_fresh']

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
    assert names('midday') == ['props', 'enrich', 'parlay_pass2']
    assert names('pretip') == ['lineups', 'props', 'enrich', 'snapshot']
    assert names('weekly') == ['player_bias', 'opponent_leaks']
