from bpm_matcher.camelot import camelot_distance, to_camelot


def test_major_and_relative_minor_share_camelot_number():
    # C major (key=0, mode=1) and A minor (key=9, mode=0) are relative keys.
    assert to_camelot(0, 1) == "8B"
    assert to_camelot(9, 0) == "8A"


def test_identical_key_distance_is_zero():
    assert camelot_distance("8B", "8B") == 0


def test_relative_major_minor_distance_is_one():
    assert camelot_distance("8B", "8A") == 1


def test_adjacent_number_same_letter_distance_is_two():
    assert camelot_distance("8B", "9B") == 2


def test_distance_wraps_around_the_wheel():
    # 1 and 12 are adjacent on the wheel (circular), not 11 apart.
    assert camelot_distance("1B", "12B") == 2


def test_opposite_side_of_wheel_is_far():
    assert camelot_distance("8B", "2B") == 12


def test_unknown_key_returns_midscale_distance():
    assert to_camelot(-1, 1) is None
    assert camelot_distance(None, "8B") == 6.5
    assert camelot_distance(None, None) == 6.5
