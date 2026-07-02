"""Phase B orchestration: suggest new tracks that fit the playlist.

Pipeline:
1. Pick seed tracks from the playlist (a named track, or the whole playlist).
2. Discover candidates via Last.fm similar-tracks (if LASTFM_API_KEY is set)
   and/or Deezer related artists (keyless).
3. Drop candidates already in the playlist.
4. Resolve candidates to ISRCs (Deezer) and fetch audio features (ReccoBeats).
5. Rank candidates with the same weighted distance Phase A uses; a
   candidate's score is its distance to the NEAREST seed track.
"""

import sys

import pandas as pd

from .enrich import features_for_candidates
from .match import cross_distance_matrix
from .sources import (
    Candidate,
    deezer_related_artist_tracks,
    lastfm_api_key,
    lastfm_similar_tracks,
    normalized_key,
    resolve_isrc,
)


def _log(msg: str):
    print(msg, file=sys.stderr, flush=True)


def _playlist_keys(playlist: pd.DataFrame) -> set[tuple[str, str]]:
    keys = set()
    for artist, title in zip(playlist["Artist Name(s)"], playlist["Track Name"]):
        # Exportify joins multiple artists with ';' - index under each one.
        for a in str(artist).split(";"):
            keys.add(normalized_key(a, str(title)))
    return keys


def discover_candidates(
    seeds: pd.DataFrame,
    playlist: pd.DataFrame,
    per_seed: int = 20,
    use_lastfm: bool = True,
    use_deezer_related: bool = False,
) -> list[Candidate]:
    """Gather deduplicated candidates not already in the playlist."""
    api_key = lastfm_api_key() if use_lastfm else None
    if use_lastfm and not api_key:
        _log("LASTFM_API_KEY not set - skipping Last.fm, using Deezer related artists instead.")
        use_deezer_related = True

    known = _playlist_keys(playlist)
    seen: set[tuple[str, str]] = set()
    candidates: list[Candidate] = []

    def add(cands: list[Candidate]):
        for c in cands:
            k = c.key()
            if k in known or k in seen:
                continue
            seen.add(k)
            candidates.append(c)

    for _, row in seeds.iterrows():
        title = str(row["Track Name"])
        artist = str(row["Artist Name(s)"]).split(";")[0]
        if api_key:
            try:
                add(lastfm_similar_tracks(artist, title, api_key, limit=per_seed))
            except Exception as e:
                _log(f"Last.fm failed for {artist} - {title}: {e}")
        if use_deezer_related:
            try:
                add(deezer_related_artist_tracks(artist, top_n_artists=3, tracks_per_artist=5))
            except Exception as e:
                _log(f"Deezer related failed for {artist}: {e}")

    return candidates


def suggest_tracks(
    playlist: pd.DataFrame,
    seeds: pd.DataFrame,
    n: int = 20,
    per_seed: int = 20,
    max_candidates: int = 120,
    use_lastfm: bool = True,
    use_deezer_related: bool = False,
    weights: dict | None = None,
) -> pd.DataFrame:
    """Return up to n new tracks ranked by fit to the seed tracks (best first)."""
    candidates = discover_candidates(
        seeds, playlist, per_seed=per_seed,
        use_lastfm=use_lastfm, use_deezer_related=use_deezer_related,
    )
    _log(f"Discovered {len(candidates)} new candidates; resolving ISRCs via Deezer...")

    resolved = []
    for c in candidates[:max_candidates]:
        try:
            resolve_isrc(c)
        except Exception as e:
            _log(f"Deezer lookup failed for {c.artist} - {c.title}: {e}")
        if c.isrc:
            resolved.append(c)
    _log(f"Resolved {len(resolved)} ISRCs; fetching audio features from ReccoBeats...")

    features = features_for_candidates(resolved)
    if features.empty:
        return features
    _log(f"Got features for {len(features)} candidates; ranking...")

    dist = cross_distance_matrix(features, seeds, weights)
    features = features.copy()
    features["distance"] = dist.min(axis=1)
    nearest = dist.argmin(axis=1)
    features["closest_seed"] = [str(seeds.iloc[j]["Track Name"]) for j in nearest]
    return features.sort_values("distance").head(n).reset_index(drop=True)
