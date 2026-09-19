// "Which BPMs actually fit an 8:30/mi pace?" — Settings -> Pace Analysis.
// Mirrors ai_dj/workout.py's pace_to_bpm() (target BPM from real Garmin
// cadence data) and bpm_matcher's bpm_filter() work-segment tolerance rule
// (tight tolerance BELOW target, no upper limit above it, half/double-time
// aware) against confirmed play history, so the classification here matches
// exactly what a real "work" segment (tempo/interval pace, e.g. 8:30/mi)
// would have accepted or rejected.

// Same fallback curve as pace_to_bpm's non-cadence branch: 171 spm @
// 9:15/mi, ~1 spm per 30 s/mi (cadence barely moves with pace; stride does).
function fallbackBpm(paceSec: number): number {
  return Math.round(Math.min(Math.max(171 + (555 - paceSec) / 30, 164), 180));
}

// pace_to_bpm(): nearest 5s cadence bucket within 15s of the target pace,
// else the linear fallback curve above.
export function paceToTargetBpm(paceSec: number, cadenceBuckets: Record<string, number> | null): number {
  if (cadenceBuckets) {
    let bestBucket: number | null = null;
    let bestDist = Infinity;
    for (const key of Object.keys(cadenceBuckets)) {
      const bucket = Number(key);
      const dist = Math.abs(bucket - paceSec);
      if (dist < bestDist) { bestDist = dist; bestBucket = bucket; }
    }
    if (bestBucket != null && bestDist <= 15) {
      return Math.round(cadenceBuckets[String(bestBucket)]);
    }
  }
  return fallbackBpm(paceSec);
}

const WORK_TOLERANCE_BPM = 3.0; // ai_dj/workout.py's BPM_TOLERANCES[0] — the
// tightest band a "work" (hard-effort, e.g. tempo/interval pace) segment
// ever uses before widening.

export type PaceFit = "fits" | "too-slow" | "too-fast";

// Effective BPM: whichever of {raw, ×2, ÷2} lands closest to target — mirrors
// bpm_filter's half_double_time handling, so a 86 BPM track reads as ~172
// against a 172 target instead of looking 86 BPM off.
function effectiveBpm(tempo: number, targetBpm: number): number {
  const candidates = [tempo, tempo * 2, tempo / 2];
  return candidates.reduce((best, c) =>
    Math.abs(c - targetBpm) < Math.abs(best - targetBpm) ? c : best
  );
}

// Mirrors bpm_filter(no_upper_limit=True): a track effectively AT or ABOVE
// target is never "too fast" for a hard-effort segment — only undershooting
// target by more than the tolerance is a real mismatch. A track below target
// by more than WORK_TOLERANCE_BPM is "too slow"; there is no "too fast" path
// here by construction (matches production), but the type/label stay
// available so a viewer of the table understands why nothing is ever flagged
// fast — see the tab's copy.
export function classifyPaceFit(tempo: number, targetBpm: number): { fit: PaceFit; effectiveBpm: number; diff: number } {
  const eff = effectiveBpm(tempo, targetBpm);
  const diff = eff - targetBpm; // positive = faster than target
  if (diff >= -WORK_TOLERANCE_BPM) return { fit: "fits", effectiveBpm: eff, diff };
  return { fit: "too-slow", effectiveBpm: eff, diff };
}

// Same window the Pace Analysis tab uses to group nearby segment builds
// under one typed-in pace — see app/api/settings/pace-analysis/route.ts.
export const PACE_ANALYSIS_WINDOW_SEC = 10;

// The exact "fits" URI list Pace Analysis would show for `paceSec` — used
// by Pace Pro to hand the LLM only confirmed-play tracks already proven to
// work at each split's pace, instead of the whole library. Callers own the
// getPlayedTracksNearPace() lookup (todays-run-history.ts) since this
// module has no DB dependency of its own by design.
export function paceAnalysisFitUris(
  paceSec: number,
  cadenceBuckets: Record<string, number> | null,
  tracksNearPace: { uri: string | null; tempo: number }[],
): string[] {
  const targetBpm = paceToTargetBpm(paceSec, cadenceBuckets);
  const seen = new Set<string>();
  const uris: string[] = [];
  for (const t of tracksNearPace) {
    if (!t.uri || seen.has(t.uri)) continue;
    if (classifyPaceFit(t.tempo, targetBpm).fit !== "fits") continue;
    seen.add(t.uri);
    uris.push(t.uri);
  }
  return uris;
}
