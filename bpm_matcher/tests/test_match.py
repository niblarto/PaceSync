from pathlib import Path

from bpm_matcher.features import load_playlist
from bpm_matcher.match import bpm_filter, find_similar, pairwise_distance_matrix

SAMPLE_CSV = Path(__file__).parent / "sample_playlist.csv"


def _load():
    return load_playlist(str(SAMPLE_CSV))


def test_load_playlist_attaches_camelot():
    df = _load()
    assert len(df) == 10
    track_a = df[df["Track Name"] == "Track A"].iloc[0]
    assert track_a["Camelot"] == "8B"


def test_half_time_track_is_the_closest_match():
    df = _load()
    dist = pairwise_distance_matrix(df)
    idx_a = df.index[df["Track Name"] == "Track A"][0]
    matches = find_similar(df, dist, idx_a, n=len(df) - 1)
    # Track B is A's exact half-time tempo AND shares its Camelot key,
    # so it should out-rank even the same-tempo relative-minor track G.
    assert matches[0].track_name == "Track B (half-time of A)"


def test_relative_minor_ranks_above_unrelated_key_and_mood():
    df = _load()
    dist = pairwise_distance_matrix(df)
    idx_a = df.index[df["Track Name"] == "Track A"][0]
    names = [m.track_name for m in find_similar(df, dist, idx_a, n=len(df) - 1)]
    assert names.index("Track G (relative minor of A)") < names.index(
        "Track J (same key/BPM as A, different mood)"
    )
    # Tracks D and H are both far off in tempo, key, and mood from A: should rank last.
    assert set(names[-2:]) == {"Track D (unrelated)", "Track H (slow ballad)"}


def test_bpm_filter_matches_half_and_double_time():
    df = _load()
    result = bpm_filter(df, target_bpm=174, tolerance=5, half_double_time=True)
    names = set(result["Track Name"])
    assert "Track B (half-time of A)" in names  # 87 BPM, exact half-time
    assert "Track D (unrelated)" not in names  # 128 BPM, no relation


def test_bpm_filter_without_half_double_time_excludes_half_time_track():
    df = _load()
    result = bpm_filter(df, target_bpm=174, tolerance=5, half_double_time=False)
    names = set(result["Track Name"])
    assert "Track B (half-time of A)" not in names


def test_bpm_filter_sorted_by_closeness():
    df = _load()
    result = bpm_filter(df, target_bpm=174, tolerance=10, half_double_time=True)
    assert list(result["bpm_diff"]) == sorted(result["bpm_diff"])
