"""Loading and preparing an Exportify playlist library for matching.

The library's storage moved from a flat Exportify CSV to PaceSync's SQLite
database (pacesync.db) — load_playlist accepts either a real CSV file path
(unchanged, still used by anything not yet migrated, e.g. tests/ad-hoc
scripts) or a "db://<db_path>::<csv_file>" pseudo-path, which reads the
`tracks` table via bpm_matcher.db_source instead. Kept as one function
with a dispatch, rather than a separate load_playlist_db, so every existing
caller (bpm_bridge.py, ai_dj_bridge.py) needs only its argument changed,
not its call site restructured.
"""

import pandas as pd

from .camelot import to_camelot
from .db_source import load_library_from_db

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

DB_PATH_PREFIX = "db://"


def load_playlist(csv_path: str) -> pd.DataFrame:
    """Load a playlist library and attach a Camelot column.

    Rows without a Tempo (tracks Spotify couldn't analyze, e.g. local files
    or podcasts) are dropped since BPM is the primary matching signal.
    """
    if csv_path.startswith(DB_PATH_PREFIX):
        db_path, _, csv_file = csv_path[len(DB_PATH_PREFIX):].partition("::")
        df = load_library_from_db(db_path, csv_file)
    else:
        df = pd.read_csv(csv_path)

    missing = [c for c in REQUIRED_COLUMNS if c not in df.columns]
    if missing:
        raise ValueError(f"CSV missing required columns: {missing}")

    df = df.dropna(subset=["Tempo"]).reset_index(drop=True)
    df["Camelot"] = [to_camelot(k, m) for k, m in zip(df["Key"], df["Mode"])]
    return df
