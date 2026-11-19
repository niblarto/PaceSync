// Turns a Runna workout's step text ("1mi warm up … (no faster than 8:50/mi)", "6 x 800m at 7:30/mi, 90s rest")
// into timed steps, and lays them along a route so the Route Finder can overlay them and play an arrow
// along them. Pure (no server imports) — the Routes page uses it in the browser.

export interface WorkoutStep {
  label: string;
  kind: "run" | "rest";
  distanceMi: number;        // 0 for a rest
  paceSec: number | null;    // seconds per mile; null for a rest
  assumedPace: boolean;      // the step named no pace, so one was filled in
  durationSec: number;
}

const KM_PER_MI = 1.609344;
const M_PER_MI = 1609.344;
const DEFAULT_EASY_PACE = 555; // 9:15/mi — the easy-run limit used elsewhere in the app

const REPS = /^\s*(\d+)\s*(?:x|×|sets?\s+of)\s*/i;
const PACE = /(\d+):(\d{2})\s*\/\s*(mi|km)/i;
const DIST = /(\d+(?:\.\d+)?)\s*(miles?|mi|km|k|meters?|metres?|m)\b/i;
const TIME = /(\d+(?:\.\d+)?)\s*(minutes?|mins?|seconds?|secs?|s)\b/i;

function paceOf(text: string): number | null {
  const m = text.match(PACE);
  if (!m) return null;
  const sec = parseInt(m[1]) * 60 + parseInt(m[2]);
  return m[3].toLowerCase() === "km" ? sec * KM_PER_MI : sec;
}

function distanceMiOf(text: string): number | null {
  const m = text.match(DIST);
  if (!m) return null;
  const v = parseFloat(m[1]);
  const u = m[2].toLowerCase();
  if (u.startsWith("mi")) return v;
  if (u === "km" || u === "k") return v / KM_PER_MI;
  return v / M_PER_MI;
}

function secondsOf(text: string): number | null {
  const m = text.match(TIME);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return m[2].toLowerCase().startsWith("m") ? v * 60 : v;
}

function labelOf(text: string): string {
  return text.replace(/\s*\((?:no faster than|or slower)[^)]*\)/gi, "").replace(/\s+/g, " ").trim().slice(0, 60);
}

function stepFrom(text: string, fallbackPace: number): WorkoutStep | null {
  const pace = paceOf(text);
  const dist = distanceMiOf(text);
  const secs = secondsOf(text);
  const label = labelOf(text);
  const isRest = /\brest\b/i.test(text) || (/\bwalk/i.test(text) && pace === null && dist === null);
  if (secs !== null && dist === null && isRest) {
    return { label, kind: "rest", distanceMi: 0, paceSec: null, assumedPace: false, durationSec: secs };
  }
  const paceSec = pace ?? fallbackPace;
  if (dist !== null) {
    return { label, kind: "run", distanceMi: dist, paceSec, assumedPace: pace === null, durationSec: dist * paceSec };
  }
  if (secs !== null) {
    return { label, kind: "run", distanceMi: secs / paceSec, paceSec, assumedPace: pace === null, durationSec: secs };
  }
  return null;
}

// Steps in order, repeats expanded. `distanceMi`/`durationSec` are the workout's own totals; they set the pace
// for steps that name none when the whole workout has no pace at all (e.g. a plain long run).
export function parseWorkoutSteps(segments: string[], workout: { distanceMi: number | null; durationSec: number }): WorkoutStep[] {
  const lines = segments.filter(l => !l.includes("•") && !/^summary/i.test(l));
  const anyPace = lines.some(l => paceOf(l) !== null);
  const fallbackPace = !anyPace && workout.distanceMi && workout.durationSec > 0
    ? workout.durationSec / workout.distanceMi
    : DEFAULT_EASY_PACE;

  const steps: WorkoutStep[] = [];
  for (const line of lines) {
    let body = line;
    let reps = 1;
    const rm = body.match(REPS);
    if (rm) { reps = Math.min(40, parseInt(rm[1])); body = body.slice(rm[0].length); }
    const parts = body.split(/,(?![^()]*\))/).map(p => p.trim()).filter(Boolean);
    const unit: WorkoutStep[] = [];
    for (const p of parts) {
      const s = stepFrom(p, fallbackPace);
      if (s) unit.push(s);
    }
    for (let i = 0; i < reps; i++) steps.push(...unit);
  }
  if (steps.length === 0 && workout.distanceMi) {
    const paceSec = workout.durationSec > 0 ? workout.durationSec / workout.distanceMi : DEFAULT_EASY_PACE;
    steps.push({ label: "Workout", kind: "run", distanceMi: workout.distanceMi, paceSec, assumedPace: true, durationSec: workout.distanceMi * paceSec });
  }
  return steps;
}

export interface TimelineSeg {
  kind: "run" | "rest" | "beyond";
  label: string;
  startMi: number;
  endMi: number;
  startSec: number;
  endSec: number;
  paceSec: number | null;
  assumedPace: boolean;
}

export interface Timeline {
  segs: TimelineSeg[];
  totalSec: number;
  workoutMi: number;     // distance the workout asks for
  routeMi: number;
}

// The steps laid end to end along a route of `routeMi`. A workout longer than the route is cut at the route's
// end; a route longer than the workout carries on in a final "beyond the workout" stretch at the last pace.
export function buildTimeline(steps: WorkoutStep[], routeMi: number): Timeline {
  const segs: TimelineSeg[] = [];
  let mi = 0, sec = 0;
  let lastPace: number | null = null;
  for (const st of steps) {
    if (mi >= routeMi - 0.005) break;
    if (st.kind === "rest") {
      segs.push({ kind: "rest", label: st.label, startMi: mi, endMi: mi, startSec: sec, endSec: sec + st.durationSec, paceSec: null, assumedPace: false });
      sec += st.durationSec;
      continue;
    }
    const d = Math.min(st.distanceMi, routeMi - mi);
    if (d <= 0.001) continue;
    const dur = d * (st.paceSec ?? DEFAULT_EASY_PACE);
    segs.push({ kind: "run", label: st.label, startMi: mi, endMi: mi + d, startSec: sec, endSec: sec + dur, paceSec: st.paceSec, assumedPace: st.assumedPace });
    mi += d; sec += dur; lastPace = st.paceSec;
  }
  if (routeMi - mi > 0.02) {
    const pace = lastPace ?? DEFAULT_EASY_PACE;
    const dur = (routeMi - mi) * pace;
    segs.push({ kind: "beyond", label: "Beyond the workout", startMi: mi, endMi: routeMi, startSec: sec, endSec: sec + dur, paceSec: pace, assumedPace: true });
    sec += dur;
  }
  return { segs, totalSec: sec, workoutMi: steps.reduce((a, s) => a + s.distanceMi, 0), routeMi };
}

// Where along the route (miles) the runner is `sec` seconds into the timeline, and which segment that is.
export function positionAt(tl: Timeline, sec: number): { mi: number; segIndex: number } {
  if (tl.segs.length === 0) return { mi: 0, segIndex: -1 };
  if (sec >= tl.totalSec) return { mi: tl.routeMi, segIndex: tl.segs.length - 1 };
  const i = Math.max(0, tl.segs.findIndex(s => sec >= s.startSec && sec < s.endSec));
  const s = tl.segs[i];
  const span = s.endSec - s.startSec;
  const t = span > 0 ? Math.min(1, Math.max(0, (sec - s.startSec) / span)) : 0;
  return { mi: s.startMi + (s.endMi - s.startMi) * t, segIndex: i };
}

export function fmtPace(sec: number): string {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}/mi`;
}

export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${m}:${String(s % 60).padStart(2, "0")}`;
}

// Faster = hotter, matching the pace zones used elsewhere (under 8:00 zone 5 … 10:00 and slower zone 1).
export function paceColor(kind: TimelineSeg["kind"], paceSec: number | null): string {
  if (kind === "rest") return "#e2e8f0";
  if (kind === "beyond" || paceSec === null) return "#64748b";
  if (paceSec < 480) return "#ef4444";
  if (paceSec < 510) return "#f97316";
  if (paceSec < 540) return "#eab308";
  if (paceSec < 600) return "#22c55e";
  return "#38bdf8";
}
