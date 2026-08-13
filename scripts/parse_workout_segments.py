"""Parses Runna workout segment lines into timed/distanced sections for the
route-map overlay (RouteMapLightbox): reads {"segments": [...]} on stdin,
prints a JSON array of {label, kind, startSec, endSec, startMi, endMi,
paceSec} on stdout.

startMi/endMi are the planned cumulative distance (duration_sec / pace_sec)
for each section — the overlay maps sections onto the route by distance
covered, not elapsed time, since Runna workouts are distance-based (a
runner going faster/slower than planned shouldn't shrink/stretch which
GPS points count as "warm up" vs "work").

Reuses ai_dj.workout.parse_workout so the overlay's section boundaries always
match what the AI DJ mixer itself builds against — no separate regex parser
to keep in sync.
"""

import json
import os
import sys

_APP_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _APP_ROOT not in sys.path:
    sys.path.insert(0, _APP_ROOT)
if not os.path.isdir(os.path.join(_APP_ROOT, "ai_dj")):
    _dev = os.path.join(os.path.dirname(_APP_ROOT), "AI_DJ")
    if os.path.isdir(os.path.join(_dev, "ai_dj")) and _dev not in sys.path:
        sys.path.insert(0, _dev)

from ai_dj.workout import parse_workout  # noqa: E402


def main():
    payload = json.load(sys.stdin)
    lines = payload.get("segments") or []

    segments = parse_workout(lines)

    out = []
    t_cursor = 0.0
    mi_cursor = 0.0
    for seg in segments:
        t_start, t_end = t_cursor, t_cursor + seg.duration_sec
        # A rest covers ground only if it's an explicit walking rest (20:00/mi
        # per the caller's convention) - any other rest is stationary, so it
        # must not consume distance in the cumulative-mile mapping even
        # though parse_workout gives it a (jogging-pace) pace_sec for its own
        # BPM-matching purposes.
        is_walking_rest = seg.kind == "rest" and "walk" in seg.label.lower()
        if seg.kind == "rest" and not is_walking_rest:
            seg_mi = 0.0
        elif seg.folded_rest_sec:
            # A short rest was folded into this segment's duration_sec by
            # parse_workout's merge pass - that folded time ran at the
            # rest's own (much slower, or stationary) pace, not this
            # segment's run pace, so it must be split out and converted
            # separately. Using duration_sec/pace_sec unmodified here
            # over-counted a work interval's distance by treating its
            # walking-rest tail as if it were run at interval pace too
            # (e.g. 5x0.62mi @ 7:25/mi + 90s walk each read as 5.56mi
            # total instead of the actual ~4.5mi).
            run_sec = seg.duration_sec - seg.folded_rest_sec
            run_mi = (run_sec / seg.pace_sec) if seg.pace_sec else 0.0
            rest_mi = (
                (seg.folded_rest_sec / seg.folded_rest_pace_sec)
                if ("walk" in seg.label.lower() and seg.folded_rest_pace_sec) else 0.0
            )
            seg_mi = run_mi + rest_mi
        else:
            seg_mi = (seg.duration_sec / seg.pace_sec) if seg.pace_sec else 0.0
        mi_start, mi_end = mi_cursor, mi_cursor + seg_mi
        out.append({
            "label": seg.label,
            "kind": seg.kind,
            "startSec": t_start,
            "endSec": t_end,
            "startMi": mi_start,
            "endMi": mi_end,
            "paceSec": 1200 if is_walking_rest else seg.pace_sec,
        })
        t_cursor = t_end
        mi_cursor = mi_end

    print(json.dumps(out))


if __name__ == "__main__":
    main()
