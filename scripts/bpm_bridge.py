"""Bridge between the Next.js API routes and the bpm_matcher package.

Usage:
  python bpm_bridge.py similar <csv_path> <track_uri> [n] [seed_json]
  python bpm_bridge.py suggest <csv_path> <track_uri> <style|tempo> [n] [seed_json]

seed_json (optional) supplies the seed track's identity and audio features
explicitly, for seeds that are NOT in the playlist CSV (e.g. BBC tracks that
haven't been added yet). Shape:
  {"name": ..., "artist": ..., "tempo": ..., "key": ..., "mode": ...,
   "energy": ..., "danceability": ..., "valence": ...}
Without it, the seed is looked up in the CSV by track URI.

Outputs JSON on stdout. Progress/diagnostics go to stderr (the suggest SSE
route forwards them to the browser as live progress lines).

The bpm_matcher package lives at the repo/app root (one level up from this
script), both in development and when deployed to the Pi.
"""

import json
import os
import sys

_APP_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _APP_ROOT not in sys.path:
    sys.path.insert(0, _APP_ROOT)

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from bpm_matcher import load_playlist  # noqa: E402
from bpm_matcher.camelot import to_camelot  # noqa: E402
from bpm_matcher.match import cross_distance_matrix  # noqa: E402

# "style": what the song feels like matters most; tempo can drift.
STYLE_WEIGHTS = {"bpm": 0.15, "camelot": 0.20, "energy": 0.25, "danceability": 0.20, "valence": 0.20}
# "tempo": lock onto the BPM (half/double-time aware); feel is secondary.
TEMPO_WEIGHTS = {"bpm": 0.70, "camelot": 0.09, "energy": 0.07, "danceability": 0.07, "valence": 0.07}


def log(msg: str):
    print(msg, file=sys.stderr, flush=True)


def find_seed(df, track_uri: str):
    track_id = track_uri.split(":")[-1]
    mask = df["Track URI"].astype(str).str.endswith(track_id)
    matches = df[mask]
    if matches.empty:
        raise SystemExit(f"Track {track_uri} not found in playlist CSV")
    return matches.index[0]


def seed_frame(df, track_uri: str, seed_json: str | None):
    """Return a one-row seed DataFrame — from explicit features if given,
    otherwise looked up in the playlist CSV."""
    if seed_json:
        s = json.loads(seed_json)
        return pd.DataFrame([{
            "Track URI": track_uri,
            "Track Name": s["name"],
            "Artist Name(s)": s["artist"],
            "Tempo": float(s["tempo"]),
            "Key": int(s["key"]),
            "Mode": int(s["mode"]),
            "Energy": float(s["energy"]),
            "Danceability": float(s["danceability"]),
            "Valence": float(s["valence"]),
            "Camelot": to_camelot(int(s["key"]), int(s["mode"])),
        }])
    return df.iloc[[find_seed(df, track_uri)]]


def cmd_similar(csv_path: str, track_uri: str, n: int, seed_json: str | None):
    df = load_playlist(csv_path)
    seed = seed_frame(df, track_uri, seed_json)
    seed_id = track_uri.split(":")[-1]

    # (n_tracks, 1) distances to the seed — no pairwise matrix needed.
    dist = cross_distance_matrix(df, seed)[:, 0]
    order = np.argsort(dist)

    results = []
    for idx in order:
        uri = str(df.iloc[idx]["Track URI"])
        if uri.endswith(seed_id):
            continue
        results.append({"uri": uri, "distance": round(float(dist[idx]), 4)})
        if len(results) >= n:
            break

    print(json.dumps({"seedUri": track_uri, "matches": results}))


# Tempo mode is a hard filter, not a preference: only candidates within
# +/-1 BPM of the seed (half/double-time aware — an 84 BPM track runs like
# 168) make the list. Without this, a thin candidate pool let 75–171 BPM
# tracks rank into a 167 BPM search.
TEMPO_TOLERANCE = 1.0


def cmd_suggest(csv_path: str, track_uri: str, mode: str, n: int, seed_json: str | None):
    from bpm_matcher.suggest import suggest_tracks

    weights = TEMPO_WEIGHTS if mode == "tempo" else STYLE_WEIGHTS
    df = load_playlist(csv_path)
    seeds = seed_frame(df, track_uri, seed_json)

    log(f"Searching for songs like {seeds.iloc[0]['Track Name']} ({mode})...")
    # Over-fetch in tempo mode: the hard BPM cut below discards most candidates.
    fetch_n = n * 5 if mode == "tempo" else n
    features = suggest_tracks(df, seeds, n=fetch_n, per_seed=60, max_candidates=80, weights=weights)

    if mode == "tempo" and not features.empty:
        seed_bpm = float(seeds.iloc[0]["Tempo"])
        t = features["Tempo"].astype(float).to_numpy()
        diff = np.minimum(np.abs(t - seed_bpm), np.minimum(np.abs(t * 2 - seed_bpm), np.abs(t / 2 - seed_bpm)))
        kept = features[diff <= TEMPO_TOLERANCE].head(n)
        log(f"Tempo filter: {len(kept)}/{len(features)} candidates within ±{TEMPO_TOLERANCE:g} BPM of {seed_bpm:.0f}.")
        features = kept

    results = []
    for _, row in features.iterrows():
        results.append({
            "name": str(row["Track Name"]),
            "artist": str(row["Artist Name(s)"]),
            "bpm": round(float(row["Tempo"])),
            "camelot": str(row["Camelot"]),
            "spotifyUrl": row["Spotify URL"] if isinstance(row["Spotify URL"], str) else None,
            "distance": round(float(row["distance"]), 4),
            # Full feature set so accepted tracks can be appended to Running.csv
            "tempo": round(float(row["Tempo"]), 3),
            "key": int(row["Key"]),
            "mode": int(row["Mode"]),
            "energy": round(float(row["Energy"]), 3),
            "danceability": round(float(row["Danceability"]), 3),
            "valence": round(float(row["Valence"]), 3),
        })

    print(json.dumps({"seedUri": track_uri, "mode": mode, "suggestions": results}))


def main():
    if len(sys.argv) < 4:
        raise SystemExit(__doc__)
    cmd, csv_path, track_uri = sys.argv[1], sys.argv[2], sys.argv[3]
    if cmd == "similar":
        n = int(sys.argv[4]) if len(sys.argv) > 4 else 25
        cmd_similar(csv_path, track_uri, n, sys.argv[5] if len(sys.argv) > 5 else None)
    elif cmd == "suggest":
        mode = sys.argv[4] if len(sys.argv) > 4 else "style"
        n = int(sys.argv[5]) if len(sys.argv) > 5 else 20
        cmd_suggest(csv_path, track_uri, mode, n, sys.argv[6] if len(sys.argv) > 6 else None)
    else:
        raise SystemExit(f"Unknown command: {cmd}")


if __name__ == "__main__":
    main()
