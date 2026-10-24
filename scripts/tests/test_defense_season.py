# scripts/tests/test_defense_season.py
from defense_season import choose_defense_season


def test_opening_night_keeps_last_season():
    # Regression: 2026-27 opening night returned 2 teams with 1 game each.
    assert choose_defense_season([1, 1], '2026-27', '2025-26') == '2025-26'


def test_partial_sample_keeps_last_season():
    assert choose_defense_season([9] + [12] * 29, '2026-27', '2025-26') == '2025-26'


def test_full_sample_switches_to_current_season():
    assert choose_defense_season([10] * 30, '2026-27', '2025-26') == '2026-27'


def test_no_data_keeps_last_season():
    assert choose_defense_season([], '2026-27', '2025-26') == '2025-26'
