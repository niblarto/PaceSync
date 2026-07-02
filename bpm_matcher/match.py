"""Within-playlist similarity matching (Phase A).

Builds a weighted distance matrix over BPM (with half/double-time
reconciliation), Camelot-wheel key distance, energy, danceability and
valence, then exposes it through sklearn's NearestNeighbors for querying.
Also provides a standalone direct BPM filter for quick "what else in this
playlist is around N BPM" lookups.
"""

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .camelot import CAMELOT_MAX_DISTANCE, camelot_distance

# BPM gets the dominant weight per project spec; the rest split the remainder.
DEFAULT_WEIGHTS = {
    "bpm": 0.5,
    "camelot": 0.2,
    "energy": 0.1,
    "danceability": 0.1,
    "valence": 0.1,
}

# BPM difference (after half/double-time reconciliation) at which the normalized
# distance saturates to 1.0. Tracks farther apart than this are equally "far".
DEFAULT_BPM_SCALE = 40.0


def _bpm_distance_matrix(
    bpm_a: np.ndarray, bpm_b: np.ndarray, half_double_time: bool, scale: float
) -> np.ndarray:
    diff = np.abs(bpm_a[:, None] - bpm_b[None, :])
    if half_double_time:
        half = np.abs(bpm_a[:, None] - 2 * bpm_b[None, :])
        double = np.abs(bpm_a[:, None] - bpm_b[None, :] / 2)
        diff = np.minimum(np.minimum(diff, half), double)
    return np.minimum(diff / scale, 1.0)


def _camelot_distance_matrix(camelot_a: np.ndarray, camelot_b: np.ndarray) -> np.ndarray:
    dist = np.empty((len(camelot_a), len(camelot_b)), dtype=float)
    # Playlist-sized data (hundreds of tracks) makes an O(n*m) python loop here
    # fast enough, and keeps camelot_distance() as the single source of truth.
    for i in range(len(camelot_a)):
        for j in range(len(camelot_b)):
            dist[i, j] = camelot_distance(camelot_a[i], camelot_b[j])
    return dist


def cross_distance_matrix(
    df_a: pd.DataFrame,
    df_b: pd.DataFrame,
    weights: dict | None = None,
    bpm_scale: float = DEFAULT_BPM_SCALE,
    half_double_time: bool = True,
) -> np.ndarray:
    """Compute a (len(df_a), len(df_b)) weighted distance matrix between two track sets."""
    weights = weights or DEFAULT_WEIGHTS

    def cols(df):
        return (
            df["Tempo"].to_numpy(dtype=float),
            df["Camelot"].to_numpy(),
            df["Energy"].to_numpy(dtype=float),
            df["Danceability"].to_numpy(dtype=float),
            df["Valence"].to_numpy(dtype=float),
        )

    bpm_a, cam_a, en_a, da_a, va_a = cols(df_a)
    bpm_b, cam_b, en_b, da_b, va_b = cols(df_b)

    d_bpm = _bpm_distance_matrix(bpm_a, bpm_b, half_double_time, bpm_scale)
    d_camelot = _camelot_distance_matrix(cam_a, cam_b) / CAMELOT_MAX_DISTANCE
    d_energy = np.abs(en_a[:, None] - en_b[None, :])
    d_dance = np.abs(da_a[:, None] - da_b[None, :])
    d_valence = np.abs(va_a[:, None] - va_b[None, :])

    return (
        weights["bpm"] * d_bpm
        + weights["camelot"] * d_camelot
        + weights["energy"] * d_energy
        + weights["danceability"] * d_dance
        + weights["valence"] * d_valence
    )


def pairwise_distance_matrix(
    df: pd.DataFrame,
    weights: dict | None = None,
    bpm_scale: float = DEFAULT_BPM_SCALE,
    half_double_time: bool = True,
) -> np.ndarray:
    """Compute an (n, n) weighted distance matrix over the playlist's tracks."""
    return cross_distance_matrix(df, df, weights, bpm_scale, half_double_time)


def build_index(distance_matrix: np.ndarray):
    # Imported lazily so environments that never call find_similar/build_index
    # (e.g. the Pi web bridge, which ranks via cross_distance_matrix + argsort)
    # don't need scikit-learn installed.
    from sklearn.neighbors import NearestNeighbors

    nn = NearestNeighbors(metric="precomputed")
    nn.fit(distance_matrix)
    return nn


@dataclass
class Match:
    index: int
    track_name: str
    artist: str
    distance: float


def find_similar(
    df: pd.DataFrame,
    distance_matrix: np.ndarray,
    track_index: int,
    n: int = 10,
) -> list[Match]:
    """Return the n tracks in df most similar to df.iloc[track_index], nearest first."""
    nn = build_index(distance_matrix)
    n_query = min(n + 1, len(df))  # +1 to account for the track matching itself at distance 0
    distances, indices = nn.kneighbors(distance_matrix[track_index : track_index + 1], n_neighbors=n_query)

    results = []
    for dist, idx in zip(distances[0], indices[0]):
        if idx == track_index:
            continue
        row = df.iloc[idx]
        results.append(Match(int(idx), row["Track Name"], row["Artist Name(s)"], float(dist)))
    return results[:n]


def bpm_filter(
    df: pd.DataFrame,
    target_bpm: float,
    tolerance: float = 5.0,
    half_double_time: bool = True,
) -> pd.DataFrame:
    """Return tracks within +/- tolerance BPM of target_bpm, sorted by closeness.

    With half_double_time=True, a target of 174 also matches tracks around 87
    (and 348), since half-time/double-time tracks often mix well together.
    """
    bpm = df["Tempo"].to_numpy(dtype=float)
    diff = np.abs(bpm - target_bpm)
    if half_double_time:
        diff = np.minimum(diff, np.abs(bpm - 2 * target_bpm))
        diff = np.minimum(diff, np.abs(bpm - target_bpm / 2))

    mask = diff <= tolerance
    result = df.loc[mask].copy()
    result["bpm_diff"] = diff[mask]
    return result.sort_values("bpm_diff")
