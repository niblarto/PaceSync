"""Bridge between the Next.js API routes and the bpm_matcher package.

Usage:
  python bpm_bridge.py similar <csv_path> <track_uri> [n]
  python bpm_bridge.py suggest <csv_path> <track_uri> <style|tempo> [n]

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

from bpm_matcher import load_playlist  # noqa: E402
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


def cmd_similar(csv_path: str, track_uri: str, n: int):
    df = load_playlist(csv_path)
    seed_idx = find_seed(df, track_uri)
    seed = df.iloc[[seed_idx]]

    # (n_tracks, 1) distances to the seed — no pairwise matrix needed.
    dist = cross_distance_matrix(df, seed)[:, 0]
    order = np.argsort(dist)

    results = []
    for idx in order:
        if idx == seed_idx:
            continue
        row = df.iloc[idx]
        results.append({"uri": str(row["Track URI"]), "distance": round(float(dist[idx]), 4)})
        if len(results) >= n:
            break

    print(json.dumps({"seedUri": track_uri, "matches": results}))


def cmd_suggest(csv_path: str, track_uri: str, mode: str, n: int):
    from bpm_matcher.suggest import suggest_tracks

    weights = TEMPO_WEIGHTS if mode == "tempo" else STYLE_WEIGHTS
    df = load_playlist(csv_path)
    seed_idx = find_seed(df, track_uri)
    seeds = df.iloc[[seed_idx]]

    log(f"Searching for songs like {seeds.iloc[0]['Track Name']} ({mode})...")
    features = suggest_tracks(df, seeds, n=n, per_seed=60, max_candidates=80, weights=weights)

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
        cmd_similar(csv_path, track_uri, int(sys.argv[4]) if len(sys.argv) > 4 else 25)
    elif cmd == "suggest":
        mode = sys.argv[4] if len(sys.argv) > 4 else "style"
        cmd_suggest(csv_path, track_uri, mode, int(sys.argv[5]) if len(sys.argv) > 5 else 20)
    else:
        raise SystemExit(f"Unknown command: {cmd}")


if __name__ == "__main__":
    main()
