"""Loading and preparing an Exportify playlist CSV for matching."""

import pandas as pd

from .camelot import to_camelot

REQUIRED_COLUMNS = [
    "Track Name",
    "Artist Name(s)",
    "Tempo",
    "Key",
    "Mode",
    "Energy",
    "Danceability",
    "Valence",
]


def load_playlist(csv_path: str) -> pd.DataFrame:
    """Load an Exportify CSV export and attach a Camelot column.

    Rows without a Tempo (tracks Spotify couldn't analyze, e.g. local files
    or podcasts) are dropped since BPM is the primary matching signal.
    """
    df = pd.read_csv(csv_path)
    missing = [c for c in REQUIRED_COLUMNS if c not in df.columns]
    if missing:
        raise ValueError(f"CSV missing required columns: {missing}")

    df = df.dropna(subset=["Tempo"]).reset_index(drop=True)
    df["Camelot"] = [to_camelot(k, m) for k, m in zip(df["Key"], df["Mode"])]
    return df
