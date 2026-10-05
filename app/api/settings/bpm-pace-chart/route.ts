import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadGarminConfig } from "@/lib/garmin-config";
import { getAllTodaysRunEntries } from "@/lib/todays-run-history";
import path from "path";

// Settings -> Pace Analysis's "Measured target pace -> outcome" chart:
// unlike the rest of this tab (which classifies a track's BPM against a
// THEORETICAL pace-derived target, see lib/pace-analysis.ts), this looks at
// what actually happened — for every confirmed "Today's Run" mix, cross-
// references each track's own BPM against the pace GarminDB recorded while
// that track played (same elapsed-time-window-averaging app/api/garmin/
// run-pacing/route.ts already does for a single run's pacing review, just
// looped across every confirmed date). Nothing is persisted — this
// recomputes from GarminDB + the existing todays_run_history rows on every
// request, same "derive, don't store" choice run-pacing itself makes.
//
// Keyed by the segment's own TARGET pace (rounded to the nearest 5s/mi),
// not by BPM — a segment's target pace is the one fixed, known-in-advance
// quantity (it's what the workout actually asked for); BPM and actual pace
// are both outcomes that varied around it. 5s/mi buckets because pace is
// continuous and a 1s bucket would fragment the already-small confirmed-
// play dataset into mostly-empty rows.
const TARGET_PACE_BUCKET_SEC = 5;
const TOLERANCE_SEC_PER_MI = 10;

// Below ~95 BPM a runner locks onto double-time, same convention as
// library-coverage/route.ts and ai_dj/workout.py's _effective_run_tempo.
const DOUBLETIME_THRESHOLD = 95;

// Mirrors app/api/garmin/run-pacing/route.ts's isEasySegment() and
// ai_dj/workout.py's _is_easy_segment_label() — kept in sync by hand across
// all three copies (two TS, one Python) since each lives in a different
// layer. A segment's saved label classifies as "easy" (warmup/
// conversational/cooldown/recovery/rest/walk) or "work" (an actual
// interval/race effort) — the same target pace can appear under both (e.g.
// an easy run's steady pace vs. a tempo workout's recovery jog at a
// similar pace), and they shouldn't be averaged together.
//
// Label-keyword matching alone is unreliable for THIS chart specifically:
// a label like "4x 0.5mi at 8:20/mi, this is your target Half Marathon
// pace + 90s walking rest" matches "rest"/"walk" and gets called easy, even
// though it's a genuine hard interval with a walking-rest clause folded
// into the same track window — the measured pace/cadence for that window
// then blends the fast interval with the stopped-or-walking rest, which is
// neither a real "easy" data point nor a real "work" one. isConsistentPace
// below catches this at the DATA level instead of trying to out-guess every
// label phrasing: a window whose own instantaneous pace varies too much
// (running into a rest/walk, or a pace change mid-window) is discarded
// entirely regardless of what kind it would have been classified as.
function isEasySegment(label: string): boolean {
  const t = label.toLowerCase();
  return (
    t.includes("warm up") || t.includes("warmup") ||
    t.includes("cool down") || t.includes("cooldown") ||
    t.includes("conversational") || t.includes("easy") || t.includes("recovery") ||
    t.includes("rest") || t.includes("walk")
  );
}

// A track's play window only counts as one real, steady-state data point
// if the pace stayed roughly constant throughout — a window that spans a
// pace CHANGE (e.g. a fast interval running into a walking rest, or a
// transition between two different segments) is neither a clean "work"
// sample nor a clean "easy" one, and averaging across it produces a
// meaningless blended pace. Checked via coefficient of variation (stdev /
// mean) on the window's own per-sample instantaneous pace — unitless, so
// the same threshold works at any speed, and it's dominated by real
// pace SHIFTS rather than GPS/footpod sample-to-sample jitter (which stays
// small relative to the mean except right at a genuine pace change).
const MAX_PACE_CV = 0.08;

type SegmentKind = "easy" | "work";

interface BucketAgg {
  targetPaceSec: number; // bucket key — rounded to TARGET_PACE_BUCKET_SEC
  kind: SegmentKind;
  sampleCount: number;
  avgActualPaceSec: number;
  smoothedPaceSec: number; // sample-count-weighted rolling average over ±ROLLING_WINDOW_BUCKETS neighbors
  avgDiffSec: number; // actual - target, positive = ran slower than target
  onCount: number;
  fastCount: number;
  slowCount: number;
  avgBpm: number | null; // effective BPM of the tracks that played at this target pace
  smoothedBpm: number | null;
  cadenceSampleCount: number; // separate count — fewer tracks have a usable cadence window than a pace one
  avgCadenceSpm: number | null; // measured steps/min, averaged over each track's play window
  smoothedCadenceSpm: number | null;
  avgStrideM: number | null; // metres per step — speed/cadence, same window as avgCadenceSpm
  smoothedStrideM: number | null;
  isExtrapolated: boolean; // true = no real samples at this bucket; every value below is interpolated/extrapolated from real neighbors, not measured
}

// Real per-target-pace outcome data is genuinely noisy at the per-bucket
// level — a single bucket's raw average can easily be a small-sample
// outlier (one tired-legs run, or a stray warmup/cooldown-kind track
// sharing a target pace with mostly work-kind tracks). A ±2-bucket
// (±10s/mi), sample-count-weighted rolling average smooths that out while
// still tracking real trend shifts.
const ROLLING_WINDOW_BUCKETS = 2;
// A bucket needs at least this many raw samples before its own average is
// trusted at all for the UI's "reliable" flag — below this, a single run's
// quirks (one hill, one bad day) can swing the whole bucket.
const MIN_RELIABLE_SAMPLES = 5;

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const config = loadGarminConfig();
  if (!config) return NextResponse.json({ error: "Garmin DB not configured" }, { status: 404 });

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(path.join(config.dbPath, "garmin_activities.db"), {
      readonly: true,
      fileMustExist: true,
    });
    db.pragma("busy_timeout = 30000");

    const activityStmt = db.prepare(`
      SELECT activity_id, start_time FROM activities
      WHERE LOWER(sport) LIKE '%running%' AND DATE(start_time) = ?
      ORDER BY distance DESC
      LIMIT 1
    `);
    const recordsStmt = db.prepare(`
      SELECT timestamp, speed, cadence FROM activity_records
      WHERE activity_id = ? AND speed IS NOT NULL
      ORDER BY timestamp
    `);

    // Per-(kind, target-pace-bucket) raw samples, accumulated across every
    // confirmed run before averaging — keeps the aggregation a single pass
    // per bucket at the end rather than an incremental running-average
    // (simpler to reason about, and this whole dataset is small — confirmed
    // runs only, once per day). Keyed by a string so kind+bucket forms one
    // Map key without a nested Map per kind.
    const samplesByBucket = new Map<string, { actualPaceSec: number; bpm: number; cadenceSpm: number | null; strideM: number | null }[]>();
    const bucketKey = (kind: SegmentKind, bucket: number) => `${kind}:${bucket}`;

    for (const entry of getAllTodaysRunEntries()) {
      if (entry.approved === false) continue; // disputed — not actually run to this mix
      const activity = activityStmt.get(entry.date) as { activity_id: string | number; start_time: string } | undefined;
      if (!activity) continue;

      const records = recordsStmt.all(activity.activity_id) as { timestamp: string; speed: number; cadence: number | null }[];
      if (records.length === 0) continue;

      const startMs = new Date(activity.start_time.replace(" ", "T")).getTime();
      const samples = records
        .map(r => ({ t: (new Date(r.timestamp.replace(" ", "T")).getTime() - startMs) / 1000, mph: r.speed, cadence: r.cadence }))
        .filter(s => !isNaN(s.t) && s.t >= 0);
      if (samples.length === 0) continue;
      const runEndSec = samples[samples.length - 1].t;

      for (const t of entry.tracks) {
        if (t.tempo == null || t.tempo <= 0 || t.targetPaceSec == null) continue;
        const end = t.startsAtSec + (t.durationSec || 0);
        if (!t.durationSec || t.startsAtSec >= runEndSec - 15) continue;
        const windowEnd = Math.min(end, runEndSec);
        const inWindow = samples.filter(s => s.t >= t.startsAtSec && s.t < windowEnd && s.mph > 0.5);
        if (inWindow.length < 5) continue;

        // Discard any window whose pace wasn't steady throughout — see
        // isConsistentPace's doc comment above. Computed on per-sample
        // instantaneous pace (not speed) since pace is the unit everything
        // else here reasons in, and its distribution is what "steady
        // effort" actually means to a runner.
        const instPaces = inWindow.map(s => 3600 / s.mph);
        const meanPace = instPaces.reduce((a, p) => a + p, 0) / instPaces.length;
        const variance = instPaces.reduce((a, p) => a + (p - meanPace) ** 2, 0) / instPaces.length;
        const paceCV = Math.sqrt(variance) / meanPace;
        if (paceCV > MAX_PACE_CV) continue;

        const avgMph = inWindow.reduce((a, s) => a + s.mph, 0) / inWindow.length;
        const actualPaceSec = 3600 / avgMph;
        const effectiveBpm = t.tempo < DOUBLETIME_THRESHOLD ? t.tempo * 2 : t.tempo;

        // Garmin stores raw cadence as one-foot strides/min — double it for
        // SPM, same convention app/api/garmin/pace-spm/route.ts and
        // app/api/garmin/run-pacing/route.ts already use.
        const cadenceSamples = inWindow.filter(s => s.cadence != null && s.cadence > 10);
        const cadenceSpm = cadenceSamples.length >= 5
          ? cadenceSamples.reduce((a, s) => a + s.cadence! * 2, 0) / cadenceSamples.length
          : null;
        // Stride length = distance covered per step — (speed in m/min) /
        // (steps/min). Derived from this same window's own avg speed/
        // cadence rather than per-sample-then-averaged, so a near-zero
        // instantaneous cadence sample can't blow up a per-sample ratio.
        const strideM = cadenceSpm != null ? (avgMph * 1609.34 / 60) / cadenceSpm : null;

        const bucket = Math.round(t.targetPaceSec / TARGET_PACE_BUCKET_SEC) * TARGET_PACE_BUCKET_SEC;
        const kind: SegmentKind = isEasySegment(t.segment) ? "easy" : "work";
        const key = bucketKey(kind, bucket);
        const list = samplesByBucket.get(key) ?? [];
        list.push({ actualPaceSec, bpm: effectiveBpm, cadenceSpm, strideM });
        samplesByBucket.set(key, list);
      }
    }
    db.close();

    const rawBuckets = Array.from(samplesByBucket.entries())
      .map(([key, samples]) => {
        const [kind, bucketStr] = key.split(":") as [SegmentKind, string];
        const targetPaceSec = Number(bucketStr);
        const avgActualPaceSec = samples.reduce((a, s) => a + s.actualPaceSec, 0) / samples.length;
        const diffs = samples.map(s => s.actualPaceSec - targetPaceSec);
        const avgDiffSec = diffs.reduce((a, d) => a + d, 0) / diffs.length;
        const onCount = diffs.filter(d => Math.abs(d) <= TOLERANCE_SEC_PER_MI).length;
        const fastCount = diffs.filter(d => d < -TOLERANCE_SEC_PER_MI).length;
        const slowCount = diffs.filter(d => d > TOLERANCE_SEC_PER_MI).length;
        const avgBpm = samples.reduce((a, s) => a + s.bpm, 0) / samples.length;
        const cadenced = samples.filter(s => s.cadenceSpm != null) as { cadenceSpm: number }[];
        const avgCadenceSpm = cadenced.length ? cadenced.reduce((a, s) => a + s.cadenceSpm, 0) / cadenced.length : null;
        const strided = samples.filter(s => s.strideM != null) as { strideM: number }[];
        const avgStrideM = strided.length ? strided.reduce((a, s) => a + s.strideM, 0) / strided.length : null;
        return {
          targetPaceSec, kind, sampleCount: samples.length, avgActualPaceSec, avgDiffSec, onCount, fastCount, slowCount,
          avgBpm, cadenceSampleCount: cadenced.length, avgCadenceSpm, avgStrideM,
        };
      })
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.targetPaceSec - b.targetPaceSec);

    // Weighted by sampleCount so a 1-sample neighbor barely nudges the
    // smoothed value while a 40-sample one dominates it — an unweighted mean
    // of raw per-bucket averages would let a near-empty bucket distort its
    // neighbors just as much as a well-sampled one. Cadence uses its own
    // (smaller) cadenceSampleCount as weight, since fewer tracks have usable
    // cadence data than pace data (cadence samples need >10, pace just needs
    // a real speed reading) — weighting cadence by the pace sample count
    // would overweight a bucket whose cadence average came from very few
    // actual cadence readings. Smoothing only ever looks at SAME-KIND
    // neighbors — an easy segment's bucket must never be smoothed using a
    // work segment's bucket at a nearby pace, since that's exactly the
    // cross-effort blending that skewed the mixer's own cadence lookup
    // (see ai_dj/workout.py's garmin_cadence_buckets_by_kind).
    const byBucket = new Map(rawBuckets.map(b => [bucketKey(b.kind, b.targetPaceSec), b]));
    const buckets: BucketAgg[] = rawBuckets.map(b => {
      let weightedSum = 0, weightTotal = 0;
      let bpmWeightedSum = 0, bpmWeightTotal = 0;
      let cadenceWeightedSum = 0, cadenceWeightTotal = 0;
      let strideWeightedSum = 0, strideWeightTotal = 0;
      for (let d = -ROLLING_WINDOW_BUCKETS; d <= ROLLING_WINDOW_BUCKETS; d++) {
        const neighbor = byBucket.get(bucketKey(b.kind, b.targetPaceSec + d * TARGET_PACE_BUCKET_SEC));
        if (!neighbor) continue;
        weightedSum += neighbor.avgActualPaceSec * neighbor.sampleCount;
        weightTotal += neighbor.sampleCount;
        bpmWeightedSum += neighbor.avgBpm * neighbor.sampleCount;
        bpmWeightTotal += neighbor.sampleCount;
        if (neighbor.avgCadenceSpm != null) {
          cadenceWeightedSum += neighbor.avgCadenceSpm * neighbor.cadenceSampleCount;
          cadenceWeightTotal += neighbor.cadenceSampleCount;
        }
        if (neighbor.avgStrideM != null) {
          strideWeightedSum += neighbor.avgStrideM * neighbor.cadenceSampleCount;
          strideWeightTotal += neighbor.cadenceSampleCount;
        }
      }
      const smoothedPaceSec = weightTotal > 0 ? weightedSum / weightTotal : b.avgActualPaceSec;
      const smoothedBpm = bpmWeightTotal > 0 ? bpmWeightedSum / bpmWeightTotal : b.avgBpm;
      const smoothedCadenceSpm = cadenceWeightTotal > 0 ? cadenceWeightedSum / cadenceWeightTotal : b.avgCadenceSpm;
      const smoothedStrideM = strideWeightTotal > 0 ? strideWeightedSum / strideWeightTotal : b.avgStrideM;
      return { ...b, smoothedPaceSec, smoothedBpm, smoothedCadenceSpm, smoothedStrideM, isExtrapolated: false };
    });

    // Fill every 5s/mi gap across each kind's own real-data range (not
    // beyond it — extrapolating far past the fastest/slowest pace ever
    // actually run would just be guessing at an effort level with zero
    // grounding) by linearly interpolating/extrapolating from the nearest
    // REAL bucket on each side. Marked isExtrapolated so the UI can show
    // these in red — a guess, not a measurement, same spirit as the
    // existing low-sample dimming but one step further (this has NO
    // samples at all, not just few).
    const filled: BucketAgg[] = [];
    for (const kind of ["easy", "work"] as const) {
      const real = buckets.filter(b => b.kind === kind).sort((a, b) => a.targetPaceSec - b.targetPaceSec);
      if (real.length === 0) continue;
      filled.push(...real);
      const minPace = real[0].targetPaceSec;
      const maxPace = real[real.length - 1].targetPaceSec;
      const realByPace = new Map(real.map(b => [b.targetPaceSec, b]));

      const interp = (lo: BucketAgg, hi: BucketAgg, frac: number, pick: (b: BucketAgg) => number | null): number | null => {
        const loV = pick(lo), hiV = pick(hi);
        if (loV == null || hiV == null) return loV ?? hiV;
        return loV + (hiV - loV) * frac;
      };

      for (let p = minPace; p <= maxPace; p += TARGET_PACE_BUCKET_SEC) {
        if (realByPace.has(p)) continue;
        // Nearest real bucket on each side — guaranteed to exist, since p
        // is strictly between minPace and maxPace, both of which are real.
        const lo = [...real].reverse().find(b => b.targetPaceSec <= p)!;
        const hi = real.find(b => b.targetPaceSec >= p)!;
        const frac = hi.targetPaceSec === lo.targetPaceSec ? 0 : (p - lo.targetPaceSec) / (hi.targetPaceSec - lo.targetPaceSec);
        filled.push({
          targetPaceSec: p, kind, sampleCount: 0, isExtrapolated: true,
          avgActualPaceSec: interp(lo, hi, frac, b => b.avgActualPaceSec) ?? p,
          smoothedPaceSec: interp(lo, hi, frac, b => b.smoothedPaceSec) ?? p,
          avgDiffSec: interp(lo, hi, frac, b => b.avgDiffSec) ?? 0,
          onCount: 0, fastCount: 0, slowCount: 0,
          avgBpm: interp(lo, hi, frac, b => b.avgBpm),
          smoothedBpm: interp(lo, hi, frac, b => b.smoothedBpm),
          cadenceSampleCount: 0,
          avgCadenceSpm: interp(lo, hi, frac, b => b.avgCadenceSpm),
          smoothedCadenceSpm: interp(lo, hi, frac, b => b.smoothedCadenceSpm),
          avgStrideM: interp(lo, hi, frac, b => b.avgStrideM),
          smoothedStrideM: interp(lo, hi, frac, b => b.smoothedStrideM),
        });
      }
    }
    filled.sort((a, b) => a.kind.localeCompare(b.kind) || a.targetPaceSec - b.targetPaceSec);

    return NextResponse.json({ buckets: filled, minReliableSamples: MIN_RELIABLE_SAMPLES });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
