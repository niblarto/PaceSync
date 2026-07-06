"""On-Pi fallback for the AI DJ mix builder.

Used by /api/ai-dj/mix when the remote AI DJ service is unreachable (PC off,
network change). Runs the same workout mixer locally with use_llm=False —
deterministic BPM/key/energy distance-chaining — and prints the same JSON
shape the remote service's POST /mix returns.

Reads {"title": ..., "segments": [...]} on stdin; the library CSV path is
argv[1]. Uses the Garmin cadence buckets for exact pace->BPM when
garmin-config.json points at a GarminDB (the remote PC can't do that — so
fallback mixes actually get *better* pace matching).
"""

import json
import os
import sys

_APP_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _APP_ROOT not in sys.path:
    sys.path.insert(0, _APP_ROOT)
# In development ai_dj lives in the sibling AI_DJ repo; on the Pi it's
# deployed to the app root alongside bpm_matcher.
if not os.path.isdir(os.path.join(_APP_ROOT, "ai_dj")):
    _dev = os.path.join(os.path.dirname(_APP_ROOT), "AI_DJ")
    if os.path.isdir(os.path.join(_dev, "ai_dj")) and _dev not in sys.path:
        sys.path.insert(0, _dev)

import pandas as pd  # noqa: E402

from bpm_matcher.camelot import to_camelot  # noqa: E402
from ai_dj.workout import (  # noqa: E402
    build_workout_playlist,
    garmin_cadence_buckets,
    max_projected_duration,
    parse_workout,
)


def _load_library(csv_path: str) -> pd.DataFrame:
    df = pd.read_csv(csv_path)
    df = df.dropna(subset=["Tempo"]).drop_duplicates(subset=["Track URI"]).reset_index(drop=True)
    df["Camelot"] = [to_camelot(k, m) for k, m in zip(df["Key"], df["Mode"])]
    return df


def _cadence_buckets() -> dict | None:
    try:
        with open(os.path.join(_APP_ROOT, "garmin-config.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        db = os.path.join(cfg["dbPath"], "garmin_activities.db")
        if os.path.exists(db):
            return garmin_cadence_buckets(db)
    except Exception:
        pass
    return None


def main():
    payload = json.load(sys.stdin)
    segments_text = payload.get("segments") or []
    csv_path = sys.argv[1]

    segments = parse_workout(segments_text)
    if not segments:
        print(json.dumps({"error": "No runnable segments recognized in the workout"}))
        sys.exit(1)

    try:
        easy_bias = float(payload.get("easyBias") or 0.0)
    except (TypeError, ValueError):
        easy_bias = 0.0

    feedback = payload.get("trackFeedback")
    if not isinstance(feedback, list):
        feedback = None

    played = payload.get("playedTracks")
    if not isinstance(played, list):
        played = None

    bpm_overrides = payload.get("bpmOverrides")
    if not isinstance(bpm_overrides, dict):
        bpm_overrides = None

    library = _load_library(csv_path)

    # One NDJSON progress line per segment; the final line is the mix (or
    # error) JSON. lib/ai-dj-mix.ts parses stdout line-by-line for these.
    def _progress(done, total, label):
        print(json.dumps({"type": "progress", "current": done, "total": total, "segment": label}), flush=True)

    try:
        playlist = build_workout_playlist(
            segments, library, model="", use_llm=False,
            cadence_buckets=_cadence_buckets(), easy_bias_sec=easy_bias,
            track_feedback=feedback, played_tracks=played,
            bpm_overrides=bpm_overrides,
            min_total_sec=max_projected_duration(segments_text), progress=_progress,
        )
    except ValueError as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

    timeline = []
    for seg_label, group in playlist.groupby("Segment", sort=False):
        target_pace = group["Target Pace"].iloc[0] if "Target Pace" in group.columns else None
        target_bpm = group["Target BPM"].iloc[0]
        timeline.append({
            "segment": seg_label,
            "targetBpm": float(target_bpm) if pd.notna(target_bpm) else None,
            "targetPaceSec": float(target_pace) if pd.notna(target_pace) else None,
            "tracks": [
                {
                    "uri": row.get("Track URI"),
                    "name": row["Track Name"],
                    "artist": row["Artist Name(s)"],
                    "startsAt": row["Starts At"],
                    "durationSec": float(row["Duration (ms)"] / 1000),
                    "tempo": float(row["Tempo"]),
                    "camelot": row["Camelot"],
                    "energy": float(row["Energy"]),
                }
                for _, row in group.iterrows()
            ],
        })

    print(json.dumps({
        "trackUris": [u for u in playlist["Track URI"] if isinstance(u, str)],
        "totalSec": float(playlist["Duration (ms)"].sum() / 1000),
        "timeline": timeline,
    }))


if __name__ == "__main__":
    main()
