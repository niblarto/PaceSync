"""Loads a playlist library directly from PaceSync's SQLite database
(pacesync.db), replacing pd.read_csv for the local, Pi-side Python
consumers (bpm_bridge.py, ai_dj_bridge.py) now that the Running app's own
library storage has migrated off flat CSV files onto SQLite.

Deliberately NOT used by ai_dj/server.py: that's a remote HTTP service (can
run on a separate machine from the Pi) and has no filesystem access to
pacesync.db, so it keeps receiving CSV text over the wire unchanged.

Produces a DataFrame with the exact same column set/shape load_playlist's
CSV path already returns, so every downstream consumer (bpm_bridge.py,
ai_dj/workout.py's build_workout_playlist/build_flow_mix) needs zero
changes — this is purely a swap of the loading mechanism.
"""

import sqlite3

import pandas as pd

# Maps the `tracks` table's columns (lib/db.ts's schema) to the Exportify
# CSV column names every downstream consumer already expects.
_COLUMN_MAP = {
    "uri": "Track URI",
    "track_name": "Track Name",
    "album_name": "Album Name",
    "artist_names": "Artist Name(s)",
    "release_date": "Release Date",
    "duration_ms": "Duration (ms)",
    "popularity": "Popularity",
    "explicit": "Explicit",
    "added_by": "Added By",
    "added_at": "Added At",
    "genres": "Genres",
    "record_label": "Record Label",
    "danceability": "Danceability",
    "energy": "Energy",
    "key": "Key",
    "loudness": "Loudness",
    "mode": "Mode",
    "speechiness": "Speechiness",
    "acousticness": "Acousticness",
    "instrumentalness": "Instrumentalness",
    "liveness": "Liveness",
    "valence": "Valence",
    "tempo": "Tempo",
    "time_signature": "Time Signature",
}


def load_library_from_db(db_path: str, csv_file: str) -> pd.DataFrame:
    """Reads every track row for `csv_file`'s playlist out of pacesync.db,
    baking in any persistent BPM correction (bpm_track_overrides) the same
    way lib/tracks-store.ts's trackRowToCsvRow already does for the
    materialized CSV — so a nudge made via the /run/[date] page is
    reflected here too, not just in the app's own CSV export.
    """
    con = sqlite3.connect(db_path, timeout=30)
    try:
        con.execute("PRAGMA busy_timeout = 30000")
        cols = ", ".join(_COLUMN_MAP.keys())
        rows = con.execute(
            f"SELECT {cols} FROM tracks WHERE csv_file = ? ORDER BY row_no",
            (csv_file,),
        ).fetchall()
        overrides = dict(con.execute("SELECT uri, value FROM bpm_track_overrides").fetchall())
    finally:
        con.close()

    df = pd.DataFrame(rows, columns=list(_COLUMN_MAP.keys()))
    df = df.rename(columns=_COLUMN_MAP)

    if not df.empty:
        overridden = df["Track URI"].map(overrides)
        df["Tempo"] = overridden.combine_first(df["Tempo"])
        # Exportify includes a "Spotify URL" column; the tracks table
        # doesn't store one separately since it's fully derivable from the
        # URI (last path segment is the Spotify track id).
        df["Spotify URL"] = "https://open.spotify.com/track/" + df["Track URI"].str.rsplit(":", n=1).str[-1]

    return df
