from pathlib import Path
from unittest.mock import patch

import pandas as pd

from bpm_matcher.enrich import features_for_candidates
from bpm_matcher.features import load_playlist
from bpm_matcher.match import cross_distance_matrix, pairwise_distance_matrix
from bpm_matcher.sources import Candidate, normalized_key
from bpm_matcher.suggest import _playlist_keys, discover_candidates

SAMPLE_CSV = Path(__file__).parent / "sample_playlist.csv"


def test_cross_distance_shape_and_consistency():
    df = load_playlist(str(SAMPLE_CSV))
    a, b = df.iloc[:4], df.iloc[4:]
    cross = cross_distance_matrix(a, b)
    assert cross.shape == (4, len(df) - 4)
    # pairwise must equal cross(df, df) with zero diagonal
    pair = pairwise_distance_matrix(df)
    assert pair.shape == (len(df), len(df))
    assert all(abs(pair[i, i]) < 1e-12 for i in range(len(df)))


def test_normalized_key_strips_version_suffixes():
    assert normalized_key("Underworld", "Born Slippy (Nuxx)") == ("underworld", "born slippy")
    assert normalized_key("EMF", "Unbelievable - 2013 Remastered") == ("emf", "unbelievable")
    assert normalized_key("The Cure", "A Forest") == ("the cure", "a forest")


def test_playlist_keys_index_each_artist_separately():
    df = pd.DataFrame(
        {
            "Track Name": ["Galvanize"],
            "Artist Name(s)": ["The Chemical Brothers;Q-Tip"],
        }
    )
    keys = _playlist_keys(df)
    assert ("the chemical brothers", "galvanize") in keys
    assert ("q-tip", "galvanize") in keys


def test_discover_candidates_dedupes_against_playlist():
    playlist = pd.DataFrame(
        {
            "Track Name": ["Known Song"],
            "Artist Name(s)": ["Known Artist"],
        }
    )
    seeds = playlist
    fake = [
        Candidate("Known Artist", "Known Song", source="lastfm:x"),  # already in playlist
        Candidate("New Artist", "New Song", source="lastfm:x"),
        Candidate("New Artist", "New Song (Remix Edit)", source="lastfm:x"),  # dupe after norm? no: '(' split -> "new song"
    ]
    with patch("bpm_matcher.suggest.lastfm_api_key", return_value="k"), patch(
        "bpm_matcher.suggest.lastfm_similar_tracks", return_value=fake
    ):
        out = discover_candidates(seeds, playlist)
    keys = [c.key() for c in out]
    assert ("known artist", "known song") not in keys
    assert keys.count(("new artist", "new song")) == 1


def test_features_for_candidates_maps_isrc_and_builds_camelot():
    cands = [
        Candidate("A", "T1", source="s", isrc="ISRC1"),
        Candidate("B", "T2", source="s", isrc="ISRC2"),
        Candidate("C", "NoIsrc", source="s"),
    ]
    api_response = [
        {"isrc": "ISRC1", "href": "url1", "tempo": 174.0, "key": 0, "mode": 1,
         "energy": 0.8, "danceability": 0.7, "valence": 0.6},
        {"isrc": "ISRC2", "href": "url2", "tempo": 128.0, "key": 9, "mode": 0,
         "energy": 0.5, "danceability": 0.5, "valence": 0.5},
    ]
    with patch("bpm_matcher.enrich._get_features_batch", return_value=api_response):
        df = features_for_candidates(cands)
    assert len(df) == 2
    row = df[df["ISRC"] == "ISRC1"].iloc[0]
    assert row["Camelot"] == "8B"  # C major
    assert row["Tempo"] == 174.0
    row2 = df[df["ISRC"] == "ISRC2"].iloc[0]
    assert row2["Camelot"] == "8A"  # A minor
