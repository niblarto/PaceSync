import type { HRZone, RunningZone } from "@/types";

// Music BPM zones derived from actual run data (runs.csv).
// Cadence is consistently 170–175 spm across all zones — pace changes via stride length.
// Z3/Z4 music anchored at cadence (~172–176 BPM); Z1/Z2 below cadence for relaxed feel;
// Z5 above cadence to drive max effort.
const ZONE_BPM: { min: number; max: number }[] = [
  { min: 120, max: 142 }, // Z1 ~10:00+/mi  cadence 170 – below cadence, recovery feel
  { min: 140, max: 162 }, // Z2 ~9:06-9:43  cadence 173 – below cadence, easy upbeat
  { min: 160, max: 174 }, // Z3 ~8:30-9:00  cadence 173 – at cadence, motivating
  { min: 172, max: 182 }, // Z4 ~8:00-8:30  cadence 175 – at/above cadence, hard push
  { min: 178, max: 198 }, // Z5 <8:00/mi    cadence 176+ – above cadence, race effort
];

// Personal zones — Garmin %HRR, max HR 166, resting HR 39.
const MAX_HR     = 166;
const RESTING_HR = 39;
const HRR        = MAX_HR - RESTING_HR;
const hrr = (pct: number) => Math.round(RESTING_HR + pct * HRR);

const DEFAULT_HR_ZONES: HRZone[] = [
  { min: hrr(0.59), max: hrr(0.68) }, // Z1 Warm Up
  { min: hrr(0.68), max: hrr(0.74) }, // Z2 Easy
  { min: hrr(0.74), max: hrr(0.83) }, // Z3 Aerobic
  { min: hrr(0.83), max: hrr(0.92) }, // Z4 Threshold
  { min: hrr(0.92), max: MAX_HR     }, // Z5 Maximum
];

const ZONE_META = [
  { name: "Warm Up",   description: "Very easy effort, warmup or cooldown",  pace: "10:00+ /mi",    color: "bg-emerald-500", textColor: "text-emerald-400" },
  { name: "Easy",      description: "Conversational pace, aerobic base",      pace: "9:06–9:43 /mi", color: "bg-green-500",   textColor: "text-green-400"   },
  { name: "Aerobic",   description: "Comfortably hard, steady state aerobic", pace: "8:30–9:00 /mi", color: "bg-yellow-500",  textColor: "text-yellow-400"  },
  { name: "Threshold", description: "Hard effort, lactate threshold",         pace: "8:00–8:30 /mi", color: "bg-orange-500",  textColor: "text-orange-400"  },
  { name: "Maximum",   description: "Race pace, VO₂ max / near max effort",  pace: "sub-8:00 /mi",  color: "bg-red-500",     textColor: "text-red-400"     },
];

export function getDefaultZones(): RunningZone[] {
  return buildRunningZones(DEFAULT_HR_ZONES);
}

export function buildRunningZones(stravaZones: HRZone[]): RunningZone[] {
  return stravaZones.slice(0, 5).map((zone, i) => ({
    number: i + 1,
    name: ZONE_META[i].name,
    description: ZONE_META[i].description,
    hrMin: zone.min,
    hrMax: zone.max,
    bpmMin: ZONE_BPM[i].min,
    bpmMax: ZONE_BPM[i].max,
    pace: ZONE_META[i].pace,
    color: ZONE_META[i].color,
    textColor: ZONE_META[i].textColor,
  }));
}

export function filterTracksByBPM<T extends { bpm: number }>(
  tracks: T[],
  bpmMin: number,
  bpmMax: number,
  tolerance = 3
): T[] {
  return tracks.filter(
    (t) => t.bpm >= bpmMin - tolerance && t.bpm <= bpmMax + tolerance
  );
}
