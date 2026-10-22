"""Reads lap records from Garmin activity files (GarminDB imports laps with
empty times/distances, so the Coach reads them straight from the FIT).

stdin: {"files": {"<activityId>": "<path to .fit or Garmin's .zip download>"}}
stdout: {"<activityId>": [{"intensity", "sec", "m", "avgHr", "maxHr", "spm"}] | {"error": str}}
"""

import io
import json
import sys
import zipfile


def laps_from(fileobj) -> list[dict]:
    import fitdecode

    out = []
    with fitdecode.FitReader(fileobj) as fr:
        for fm in fr:
            if not isinstance(fm, fitdecode.FitDataMessage) or fm.name != "lap":
                continue
            g = lambda k: fm.get_value(k, fallback=None)  # noqa: E731
            cad = g("avg_running_cadence") or g("avg_cadence")
            frac = g("avg_fractional_cadence") or 0
            out.append({
                "intensity": str(g("intensity") or "active"),
                "sec": round(float(g("total_timer_time") or 0), 1),
                "m": round(float(g("total_distance") or 0), 1),
                "avgHr": g("avg_heart_rate"),
                "maxHr": g("max_heart_rate"),
                # FIT running cadence is per leg — double it for steps/min.
                "spm": round((float(cad) + float(frac)) * 2) if cad else None,
            })
    return out


def main() -> None:
    files = (json.loads(sys.stdin.read() or "{}").get("files") or {})
    result = {}
    for act_id, path in files.items():
        try:
            if str(path).lower().endswith(".zip"):
                with zipfile.ZipFile(path) as z:
                    name = next(n for n in z.namelist() if n.lower().endswith(".fit"))
                    result[act_id] = laps_from(io.BytesIO(z.read(name)))
            else:
                with open(path, "rb") as f:
                    result[act_id] = laps_from(f)
        except Exception as e:  # noqa: BLE001
            result[act_id] = {"error": str(e)[:200]}
    print(json.dumps(result))


if __name__ == "__main__":
    main()
