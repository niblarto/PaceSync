import path from "path";
import { getDb } from "@/lib/db";
import { loadGarminConfig } from "@/lib/garmin-config";
import { fetchRunnaSchedule, type RunnaPastRun, type RunnaWorkout } from "@/lib/runna-schedule";
import { listRaces } from "@/lib/races";
import { listRunFeedback, effortLabel, FEEL_LABELS, type RunFeedback } from "@/lib/run-feedback";
import { formatLaps, getCurrentHrZones, type FitLap, getHrvDays, getRunLaps, getZoneSplits, isStructured, zonesText, type HrvDay, type HrZones } from "@/lib/coach-garmin-extra";

// The training brief the Coach reads before every reply: who the athlete
// is right now (load, recovery, recent runs with weather), what's planned
// and what they're training for. Plain text, units in miles — it goes
// straight into the model's system prompt.

const RECENT_RUN_DAYS = 28;
const WEEKS = 12;
const WEATHER_RUNS = 10;
const LAP_RUNS = 8;

interface ActivityRow {
  activity_id: string;
  name: string | null;
  sport: string | null;
  sub_sport: string | null;
  calories: number | null;
  start_time: string;
  elapsed_time: string | null;
  moving_time: string | null;
  distance: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  ascent: number | null;
  training_load: number | null;
  training_effect: number | null;
  anaerobic_training_effect: number | null;
  start_lat: number | null;
  start_long: number | null;
  spm: number | null;
  vo2_max: number | null;
  z1: string | null; z2: string | null; z3: string | null; z4: string | null; z5: string | null;
  hrz_1_hr: number | null; hrz_2_hr: number | null; hrz_3_hr: number | null; hrz_4_hr: number | null; hrz_5_hr: number | null;
}

export interface CoachContext {
  text: string;
  generatedAt: string;
  runCount: number;
}

function secs(t: string | null): number {
  if (!t) return 0;
  const m = t.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

function clock(sec: number): string {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

function pace(sec: number, mi: number | null): string {
  if (!mi || mi < 0.05 || !sec) return "-";
  return `${clock(sec / mi)}/mi`;
}

function weekday(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short" });
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function openGarmin(file: string) {
  const config = loadGarminConfig();
  if (!config) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(path.join(config.dbPath, file), { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 30000");
    return db;
  } catch {
    return null;
  }
}

// ── Weather (Open-Meteo, cached per activity) ───────────────────────────────

interface RunWeather { tempC: number; feelsC: number; humidity: number; windMph: number; rainMm: number }

async function runWeather(a: ActivityRow): Promise<RunWeather | null> {
  if (a.start_lat == null || a.start_long == null) return null;
  const key = `coach_weather:${a.activity_id}`;
  const db = getDb();
  const cached = db.prepare("SELECT value_json FROM kv_config WHERE key = ?").get(key) as { value_json: string } | undefined;
  if (cached) {
    try { return JSON.parse(cached.value_json) as RunWeather; } catch {}
  }
  const date = a.start_time.slice(0, 10);
  const hour = Number(a.start_time.slice(11, 13));
  const daysAgo = (Date.now() - new Date(`${date}T12:00:00`).getTime()) / 86_400_000;
  // The forecast API covers roughly the last 3 months; the archive the rest.
  const base = daysAgo < 80 ? "https://api.open-meteo.com/v1/forecast" : "https://archive-api.open-meteo.com/v1/archive";
  const url = `${base}?latitude=${a.start_lat.toFixed(3)}&longitude=${a.start_long.toFixed(3)}&start_date=${date}&end_date=${date}`
    + "&hourly=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,precipitation&wind_speed_unit=mph&timezone=auto";
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const d = await res.json() as { hourly?: Record<string, number[]> };
    const h = d.hourly;
    if (!h?.temperature_2m?.length) return null;
    const i = Math.min(hour, h.temperature_2m.length - 1);
    const w: RunWeather = {
      tempC: Math.round(h.temperature_2m[i]),
      feelsC: Math.round(h.apparent_temperature?.[i] ?? h.temperature_2m[i]),
      humidity: Math.round(h.relative_humidity_2m?.[i] ?? 0),
      windMph: Math.round(h.wind_speed_10m?.[i] ?? 0),
      rainMm: Math.round((h.precipitation?.[i] ?? 0) * 10) / 10,
    };
    // Only cache once the day is over — today's hours can still be forecasts.
    if (daysAgo >= 1) {
      db.prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
        .run(key, JSON.stringify(w));
    }
    return w;
  } catch {
    return null;
  }
}

function weatherText(w: RunWeather | null | undefined): string {
  if (!w) return "";
  const feels = Math.abs(w.feelsC - w.tempC) >= 2 ? ` (feels ${w.feelsC}°C)` : "";
  return `${w.tempC}°C${feels}, ${w.humidity}% humidity, wind ${w.windMph}mph${w.rainMm > 0 ? `, rain ${w.rainMm}mm/h` : ""}`;
}

// ── Sections ────────────────────────────────────────────────────────────────

function loadActivities(sinceDate: string): ActivityRow[] {
  const db = openGarmin("garmin_activities.db");
  if (!db) return [];
  try {
    return db.prepare(`
      SELECT a.activity_id, a.name, a.sport, a.sub_sport, a.calories, a.start_time, a.elapsed_time, a.moving_time, a.distance,
             a.avg_hr, a.max_hr, a.ascent, a.training_load, a.training_effect, a.anaerobic_training_effect,
             a.start_lat, a.start_long, s.avg_steps_per_min AS spm, s.vo2_max,
             a.hrz_1_time AS z1, a.hrz_2_time AS z2, a.hrz_3_time AS z3, a.hrz_4_time AS z4, a.hrz_5_time AS z5,
             a.hrz_1_hr, a.hrz_2_hr, a.hrz_3_hr, a.hrz_4_hr, a.hrz_5_hr
      FROM activities a LEFT JOIN steps_activities s USING (activity_id)
      WHERE DATE(a.start_time) >= ?
      ORDER BY a.start_time DESC
    `).all(sinceDate) as ActivityRow[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function isRun(a: ActivityRow): boolean {
  return (a.sport ?? "").toLowerCase().includes("run");
}

// Time in zone: recalculated against the athlete's CURRENT Garmin zones
// when available (index 0 = below Z1, folded into Z1), else the zone times
// Garmin stored with the run (zones as they were on the day).
function zoneSplit(a: ActivityRow, recalculated?: number[]): string {
  const z = recalculated
    ? [recalculated[0] + recalculated[1], ...recalculated.slice(2)]
    : [a.z1, a.z2, a.z3, a.z4, a.z5].map(secs);
  const total = z.reduce((x, y) => x + y, 0);
  if (!total) return "";
  return "zones " + z.map((s, i) => `Z${i + 1} ${Math.round((s / total) * 100)}%`).join(" ");
}

function wellnessSection(hrvApi: Map<string, HrvDay>): string[] {
  const db = openGarmin("garmin.db");
  if (!db) return [];
  const since = localDate(new Date(Date.now() - 7 * 86_400_000));
  try {
    const days = db.prepare(`
      SELECT DATE(d.day) AS day, d.rhr, d.stress_avg, d.bb_max, s.total_sleep, s.score AS sleep_score, s.qualifier,
             h.last_night_avg AS hrv, h.status AS hrv_status
      FROM daily_summary d
      LEFT JOIN sleep s ON DATE(s.day) = DATE(d.day)
      LEFT JOIN hrv h ON DATE(h.day) = DATE(d.day)
      WHERE DATE(d.day) >= ?
      ORDER BY d.day DESC
    `).all(since) as { day: string; rhr: number | null; stress_avg: number | null; bb_max: number | null; total_sleep: string | null; sleep_score: number | null; qualifier: string | null; hrv: number | null; hrv_status: string | null }[];
    if (!days.length) return [];
    const lines = ["## Recovery — last 7 days (Garmin)"];
    for (const d of days) {
      const parts = [
        d.rhr != null ? `resting HR ${d.rhr}` : "",
        d.total_sleep ? `sleep ${clock(secs(d.total_sleep)).replace(/:\d\d$/, "")}h${d.sleep_score != null ? ` (score ${d.sleep_score}${d.qualifier ? ` ${d.qualifier.toLowerCase()}` : ""})` : ""}` : "",
        (() => {
          // GarminDB's HRV table is empty — prefer the Personal API's.
          const h = hrvApi.get(d.day);
          if (h?.lastNightAvg != null) {
            const base = h.balancedLow != null && h.balancedUpper != null ? `, baseline ${h.balancedLow}-${h.balancedUpper}` : "";
            return `HRV ${h.lastNightAvg}ms (7-day avg ${h.weeklyAvg ?? "-"}${base}${h.status ? `, ${h.status.toLowerCase()}` : ""})`;
          }
          return d.hrv != null ? `HRV ${d.hrv}${d.hrv_status ? ` ${d.hrv_status.toLowerCase()}` : ""}` : "";
        })(),
        d.stress_avg != null ? `stress ${d.stress_avg}` : "",
        d.bb_max != null ? `body battery max ${d.bb_max}` : "",
      ].filter(Boolean);
      if (parts.length) lines.push(`- ${weekday(d.day)} ${d.day}: ${parts.join(", ")}`);
    }
    return lines;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function weeklySection(acts: ActivityRow[]): string[] {
  const runs = acts.filter(isRun);
  if (!runs.length) return [];
  const others = acts.filter(a => !isRun(a));
  const monday = (d: string) => {
    const dt = new Date(`${d}T12:00:00`);
    dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
    return localDate(dt);
  };
  const weeks = new Map<string, { runs: number; mi: number; sec: number; load: number; long: number }>();
  for (const r of runs) {
    const w = monday(r.start_time.slice(0, 10));
    const e = weeks.get(w) ?? { runs: 0, mi: 0, sec: 0, load: 0, long: 0 };
    e.runs++;
    e.mi += r.distance ?? 0;
    e.sec += secs(r.moving_time ?? r.elapsed_time);
    e.load += r.training_load ?? 0;
    e.long = Math.max(e.long, r.distance ?? 0);
    weeks.set(w, e);
  }
  // Cross-training (walks, strength, cycling, ...) per week.
  const otherWeeks = new Map<string, { n: number; sec: number; load: number }>();
  for (const a of others) {
    const w = monday(a.start_time.slice(0, 10));
    const e = otherWeeks.get(w) ?? { n: 0, sec: 0, load: 0 };
    e.n++;
    e.sec += secs(a.moving_time ?? a.elapsed_time);
    e.load += a.training_load ?? 0;
    otherWeeks.set(w, e);
  }
  const lines = [`## Weekly volume — last ${WEEKS} weeks (Mon-Sun, current week partial)`];
  for (const [w, e] of Array.from(weeks.entries()).sort((a, b) => b[0].localeCompare(a[0]))) {
    const o = otherWeeks.get(w);
    const other = o ? `; plus ${o.n} other session${o.n === 1 ? "" : "s"} (${clock(o.sec)}, load ${Math.round(o.load)})` : "";
    lines.push(`- w/c ${w}: ${e.runs} runs, ${e.mi.toFixed(1)}mi, ${clock(e.sec)}, longest ${e.long.toFixed(1)}mi, training load ${Math.round(e.load)}${other}`);
  }
  return lines;
}

async function recentRunsSection(acts: ActivityRow[], pastRuns: RunnaPastRun[], zones: HrZones | null): Promise<{ lines: string[]; count: number }> {
  const cutoff = localDate(new Date(Date.now() - RECENT_RUN_DAYS * 86_400_000));
  const runs = acts.filter(a => isRun(a) && a.start_time.slice(0, 10) >= cutoff);
  if (!runs.length) return { lines: [], count: 0 };
  const weather = await Promise.all(runs.slice(0, WEATHER_RUNS).map(runWeather));
  const byDate = new Map(pastRuns.map(p => [p.date, p]));
  const feedbackByDate = new Map<string, RunFeedback[]>();
  for (const f of listRunFeedback(cutoff)) feedbackByDate.set(f.date, [...(feedbackByDate.get(f.date) ?? []), f]);
  // Lap-by-lap detail (watch FIT) for the most recent runs.
  const lapsById = await getRunLaps(runs.slice(0, LAP_RUNS).map(r => String(r.activity_id))).catch(() => new Map());
  const splits = zones ? getZoneSplits(runs.map(r => String(r.activity_id)), zones) : new Map<string, number[]>();
  const lines = [`## Runs — last ${RECENT_RUN_DAYS} days (newest first, Garmin)`];
  runs.forEach((r, i) => {
    const date = r.start_time.slice(0, 10);
    const sec = secs(r.moving_time ?? r.elapsed_time);
    const plan = byDate.get(date);
    const title = plan?.title ?? r.name ?? "Run";
    const parts = [
      `${(r.distance ?? 0).toFixed(2)}mi in ${clock(sec)} (${pace(sec, r.distance)})`,
      r.avg_hr != null ? `HR avg ${r.avg_hr}/max ${r.max_hr ?? "-"}` : "",
      r.spm != null ? `cadence ${Math.round(r.spm)}spm` : "",
      r.ascent ? `ascent ${Math.round(r.ascent)}ft` : "",
      r.training_effect != null ? `training effect aerobic ${r.training_effect}/anaerobic ${r.anaerobic_training_effect ?? 0}` : "",
      r.training_load != null ? `load ${Math.round(r.training_load)}` : "",
      zoneSplit(r, splits.get(String(r.activity_id))),
      i < WEATHER_RUNS ? weatherText(weather[i]) : "",
    ].filter(Boolean);
    lines.push(`- ${weekday(date)} ${date} ${r.start_time.slice(11, 16)} — ${title}: ${parts.join("; ")}`);
    // The athlete's own post-run rating (Summary card). If two runs share a
    // date, prefer the one whose title matches.
    const fbs = feedbackByDate.get(date) ?? [];
    const fb = fbs.find(f => f.title === title) ?? (fbs.length === 1 ? fbs[0] : undefined);
    if (fb) {
      const rated = [
        fb.effort != null ? `effort ${fb.effort}/10 (${effortLabel(fb.effort)})` : "",
        fb.feel != null ? `felt ${FEEL_LABELS[fb.feel - 1].toLowerCase()} (${fb.feel}/5)` : "",
      ].filter(Boolean).join(", ");
      lines.push(`  athlete's rating: ${rated || "no score"}${fb.notes ? ` — notes: "${fb.notes.replace(/\s+/g, " ")}"` : ""}`);
    }
    // Plan vs actual for the most recent sessions.
    if (i < LAP_RUNS) {
      if (plan?.planSteps.length) lines.push(`  planned: ${plan.planSteps.join(" | ")}`);
      const laps = lapsById.get(String(r.activity_id));
      if (laps && (isStructured(laps) || !plan?.laps.length) && laps.length > 1) {
        // Structured workouts: the watch's own warm-up/rep/rest/cool-down laps.
        lines.push(`  ${isStructured(laps) ? "workout laps (watch)" : "laps (watch)"}: ${formatLaps(laps)}`);
      } else if (plan?.laps.length) {
        lines.push(`  laps: ${plan.laps.slice(0, 16).join(" | ")}`);
      }
    }
  });
  return { lines, count: runs.length };
}

// Everything that isn't a run (walks, strength, cycling, hiking, ...), dated,
// so the coach counts it in plan-vs-actual and load/recovery.
function sportLabel(a: ActivityRow): string {
  const sub = (a.sub_sport ?? "").toLowerCase();
  const sport = (a.sport ?? "").toLowerCase();
  if (sub === "strength_training" || sport === "training") return "Strength";
  if (sport === "walking") return "Walk";
  if (sport === "hiking") return "Hike";
  if (sport === "cycling") return "Ride";
  return (a.sub_sport && a.sub_sport !== "generic" ? a.sub_sport : a.sport ?? "Activity").replace(/_/g, " ");
}

// ── Split verdicts ──────────────────────────────────────────────────────────
// Pace comparisons are worked out here rather than left to the model (which
// tends to read a faster-than-target split as a miss). Rule: from 15 s/mi
// faster to 5 s/mi slower than target is a hit; easy/conversational running
// should be at or slower than its cap (slower is correct, never "slow").

const FAST_OK_SEC = 15;
const SLOW_TOL_SEC = 5;

function paceSec(s: string): number {
  const [m, sec] = s.split(":").map(Number);
  return m * 60 + sec;
}

const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;

type StepTarget =
  | { kind: "range"; lo: number; hi: number; mid: number | null }
  | { kind: "target"; t: number }
  | { kind: "cap"; cap: number }
  | { kind: "easy" }
  | { kind: "none" };

function stepTarget(step: string): StepTarget {
  const range = step.match(/\((\d+:\d{2})\s*-\s*(\d+:\d{2})\s*\/mi\)/);
  const at = step.match(/at (\d+:\d{2})\s*\/mi/);
  if (range) return { kind: "range", lo: paceSec(range[1]), hi: paceSec(range[2]), mid: at ? paceSec(at[1]) : null };
  if (at) return { kind: "target", t: paceSec(at[1]) };
  const cap = step.match(/no faster than (\d+:\d{2})\s*\/mi/);
  if (cap) return { kind: "cap", cap: paceSec(cap[1]) };
  if (/conversational|easy/i.test(step)) return { kind: "easy" };
  return { kind: "none" };
}

function verdict(actual: number, t: StepTarget): string {
  switch (t.kind) {
    case "range": {
      const goal = `target ${mmss(t.lo)}-${mmss(t.hi)}/mi`;
      if (actual >= t.lo && actual <= t.hi) return `${goal} → ✓ within target range`;
      if (actual < t.lo) {
        const d = t.lo - actual;
        return d <= FAST_OK_SEC ? `${goal} → ✓ slightly faster than range (${Math.round(d)}s/mi)` : `${goal} → ⚠ ${Math.round(d)}s/mi faster than range (well ahead; check effort)`;
      }
      const slow = actual - t.hi;
      return slow <= SLOW_TOL_SEC ? `${goal} → ✓ within target range (${Math.round(slow)}s/mi slower, within tolerance)` : `${goal} → ✗ ${Math.round(slow)}s/mi slower than range`;
    }
    case "target": {
      const goal = `target ${mmss(t.t)}/mi`;
      const d = actual - t.t;
      if (d <= 0) {
        if (-d <= FAST_OK_SEC) return `${goal} → ✓ on target${d < 0 ? ` (${Math.round(-d)}s/mi faster, ideal)` : ""}`;
        return `${goal} → ⚠ ${Math.round(-d)}s/mi faster than target (well ahead; check effort)`;
      }
      if (d <= SLOW_TOL_SEC) return `${goal} → ✓ on target (${Math.round(d)}s/mi slower, within tolerance)`;
      return `${goal} → ✗ ${Math.round(d)}s/mi slower than target`;
    }
    case "cap":
      return actual >= t.cap
        ? `easy, no faster than ${mmss(t.cap)}/mi → ✓ kept easy (at or slower than the cap is exactly right)`
        : `easy, no faster than ${mmss(t.cap)}/mi → ⚠ ${Math.round(t.cap - actual)}s/mi faster than the easy cap`;
    case "easy":
      return "conversational, no pace target → ✓ (judge by effort/HR)";
    default:
      return "";
  }
}

interface SplitIn { label: string; mi: number; sec: number; hr: string }

function fmtSplit(s: SplitIn, step: string | undefined): string {
  const pace = s.mi > 0.05 ? s.sec / s.mi : 0;
  const base = `${s.label} ${s.mi.toFixed(2)}mi @ ${pace ? `${mmss(pace)}/mi` : "-"}${s.hr ? ` (${s.hr})` : ""}`;
  if (!step || !pace) return base;
  const v = verdict(pace, stepTarget(step));
  return v ? `${base} — ${v}` : base;
}

// Runna's per-segment splits ("2.00 mi @ 8:27 /mi") lined up with the plan
// steps one-to-one, for non-interval sessions. HR from the watch's laps when
// they line up too.
function judgeSegments(planSteps: string[], runnaLaps: string[], watch: FitLap[] | undefined): string | null {
  if (planSteps.some(s => /reps? of/i.test(s) || s.trim().startsWith("•"))) return null;
  const segs = runnaLaps
    .map(l => l.match(/([\d.]+)\s*mi\s*@\s*(\d+:\d{2})/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map(m => ({ mi: Number(m[1]), pace: paceSec(m[2]) }))
    .filter(s => s.mi >= 0.1);
  if (segs.length !== planSteps.length) return null;
  const wl = (watch ?? []).filter(l => l.m / 1609.344 >= 0.1);
  const hrFor = (i: number) => {
    const l = wl.length === segs.length ? wl[i] : undefined;
    return l?.avgHr != null ? `HR ${l.avgHr}${l.maxHr != null ? `/${l.maxHr}` : ""}` : "";
  };
  return segs.map((s, i) => fmtSplit({ label: `segment ${i + 1}`, mi: s.mi, sec: s.pace * s.mi, hr: hrFor(i) }, planSteps[i])).join(" | ");
}

// Structured watch laps (warm-up / reps / rests / cool-down) judged against
// the plan's warm-up, rep and cool-down steps.
function judgeWorkoutLaps(planSteps: string[], laps: FitLap[]): string {
  const warm = planSteps.find(s => /warm.?up/i.test(s));
  const cool = planSteps.find(s => /cool.?down/i.test(s));
  const rep = planSteps.find(s => s.trim().startsWith("•") && /\/mi/.test(s));
  let n = 0;
  return laps
    .filter(l => l.sec >= 15)
    .map(l => {
      const mi = l.m / 1609.344;
      const hr = l.avgHr != null ? `HR ${l.avgHr}${l.maxHr != null && l.intensity !== "rest" && l.intensity !== "recovery" ? `/${l.maxHr}` : ""}` : "";
      if (l.intensity === "rest" || l.intensity === "recovery") return `rest ${mmss(l.sec)}${hr ? ` (${hr})` : ""}`;
      if (l.intensity === "warmup") return fmtSplit({ label: "warm-up", mi, sec: l.sec, hr }, warm);
      if (l.intensity === "cooldown") return fmtSplit({ label: "cool-down", mi, sec: l.sec, hr }, cool);
      return fmtSplit({ label: `rep ${++n}`, mi, sec: l.sec, hr }, rep);
    })
    .join(" | ");
}

// Day-by-day plan vs actual for the last 7 days (today included), built
// here so the coach doesn't have to infer what was planned. Plan comes from
// the Runna feed: a completed/past entry carries the planned session's title;
// a day with no Runna session is a genuine rest day.
async function dayByDaySection(acts: ActivityRow[], pastRuns: RunnaPastRun[], workouts: RunnaWorkout[]): Promise<string[]> {
  const today = localDate(new Date());
  const weekStart = localDate(new Date(Date.now() - 6 * 86_400_000));
  const weekRuns = acts.filter(a => isRun(a) && a.start_time.slice(0, 10) >= weekStart);
  const watchLaps = await getRunLaps(weekRuns.map(r => String(r.activity_id))).catch(() => new Map());
  const lines = ["## Day by day — last 7 days (PLAN from Runna, ACTUAL from Garmin). Use this for plan vs actual; it is complete."];
  for (let i = 6; i >= 0; i--) {
    const date = localDate(new Date(Date.now() - i * 86_400_000));
    const past = pastRuns.find(p => p.date === date);
    const upcoming = workouts.find(w => w.date === date);

    let plan: string;
    if (past && past.type !== "rest" && !past.uid.startsWith("GARMIN_WALK_") && !past.uid.startsWith("SYNTHETIC_REST_")) {
      plan = past.uid.startsWith("GARMIN_ORPHAN_")
        ? `${past.title} (Runna entry missing; plan taken from the Garmin activity name)`
        : past.title;
      if (past.planSteps.length) plan += ` — steps: ${past.planSteps.slice(0, 10).join(" | ")}`;
    } else if (upcoming && upcoming.type !== "rest") {
      plan = upcoming.title + (upcoming.distanceMi ? ` (${upcoming.distanceMi.toFixed(1)}mi)` : "");
      if (upcoming.segments.length) plan += ` — steps: ${upcoming.segments.slice(0, 10).join(" | ")}`;
    } else {
      plan = "Rest day (no session in the Runna plan)";
    }

    const done = acts
      .filter(a => a.start_time.slice(0, 10) === date)
      .sort((a, b) => a.start_time.localeCompare(b.start_time))
      .map(a => {
        const sec = secs(a.moving_time ?? a.elapsed_time);
        const what = isRun(a) ? "Run" : sportLabel(a);
        const bits = [
          a.distance ? `${a.distance.toFixed(2)}mi` : "",
          clock(sec),
          isRun(a) ? pace(sec, a.distance) : "",
          a.avg_hr != null ? `HR avg ${a.avg_hr}` : "",
          a.training_load != null ? `load ${Math.round(a.training_load)}` : "",
        ].filter(Boolean);
        return `${what} ${a.start_time.slice(11, 16)} (${bits.join(", ")})`;
      });
    const actual = done.length ? done.join("; ") : date === today ? "nothing recorded yet today" : "nothing recorded";
    lines.push(`- ${weekday(date)} ${date}${date === today ? " (TODAY)" : ""}: PLAN: ${plan}. ACTUAL: ${actual}.`);

    // Splits for each run that day, so each planned segment can be judged:
    // the watch's workout laps (with HR) for structured sessions, otherwise
    // Runna's per-segment splits, otherwise the watch's auto laps.
    for (const r of weekRuns.filter(a => a.start_time.slice(0, 10) === date)) {
      const laps: FitLap[] | undefined = watchLaps.get(String(r.activity_id));
      const steps = past?.planSteps ?? [];
      const judged = past?.laps.length ? judgeSegments(steps, past.laps, laps) : null;
      if (laps && isStructured(laps) && laps.length > 1) {
        lines.push(`  SPLITS vs PLAN (watch workout laps): ${steps.length ? judgeWorkoutLaps(steps, laps) : formatLaps(laps)}`);
      } else if (judged) {
        lines.push(`  SPLITS vs PLAN: ${judged}`);
      } else if (past?.laps.length) {
        lines.push(`  SPLITS (per planned segment): ${past.laps.slice(0, 16).join(" | ")}`);
        if (laps && laps.length > 1) lines.push(`  watch laps (HR): ${formatLaps(laps)}`);
      } else if (laps && laps.length > 1) {
        lines.push(`  SPLITS (watch laps): ${formatLaps(laps)}`);
      }
    }
  }
  return lines;
}

function otherTrainingSection(acts: ActivityRow[]): string[] {
  const cutoff = localDate(new Date(Date.now() - RECENT_RUN_DAYS * 86_400_000));
  const others = acts.filter(a => !isRun(a) && a.start_time.slice(0, 10) >= cutoff);
  if (!others.length) return [];
  const lines = [`## Other training — last ${RECENT_RUN_DAYS} days (walks, strength, etc.; newest first, Garmin)`];
  for (const a of others) {
    const date = a.start_time.slice(0, 10);
    const sec = secs(a.moving_time ?? a.elapsed_time);
    const parts = [
      clock(sec),
      a.distance ? `${a.distance.toFixed(2)}mi` : "",
      a.avg_hr != null ? `HR avg ${a.avg_hr}/max ${a.max_hr ?? "-"}` : "",
      a.calories ? `${Math.round(a.calories)} kcal` : "",
      a.training_load != null ? `load ${Math.round(a.training_load)}` : "",
    ].filter(Boolean);
    lines.push(`- ${weekday(date)} ${date} ${a.start_time.slice(11, 16)} — ${sportLabel(a)}${a.name && a.name !== sportLabel(a) ? ` (${a.name})` : ""}: ${parts.join("; ")}`);
  }
  return lines;
}

function upcomingSection(workouts: RunnaWorkout[]): string[] {
  const today = localDate(new Date());
  const until = localDate(new Date(Date.now() + 10 * 86_400_000));
  const next = workouts.filter(w => w.date >= today && w.date <= until).sort((a, b) => a.date.localeCompare(b.date));
  if (!next.length) return [];
  const lines = ["## Planned sessions — next 10 days (Runna plan)"];
  for (const w of next) {
    const head = `${weekday(w.date)} ${w.date}${w.date === today ? " (TODAY)" : ""} — ${w.title}`
      + (w.distanceMi ? ` (${w.distanceMi.toFixed(1)}mi${w.durationSec ? `, ~${Math.round(w.durationSec / 60)}min` : ""})` : "");
    lines.push(`- ${head}`);
    if (w.segments.length && w.type !== "rest") lines.push(`  steps: ${w.segments.slice(0, 14).join(" | ")}`);
  }
  return lines;
}

function racesSection(): string[] {
  const races = listRaces();
  const today = localDate(new Date());
  const upcoming = races.filter(r => r.status === "upcoming" && (!r.raceDate || r.raceDate >= today));
  const done = races.filter(r => r.status === "completed").sort((a, b) => (b.raceDate ?? "").localeCompare(a.raceDate ?? "")).slice(0, 4);
  const lines: string[] = [];
  if (upcoming.length) {
    lines.push("## Upcoming races (goals)");
    for (const r of upcoming) {
      const weeks = r.raceDate ? Math.round((new Date(`${r.raceDate}T12:00:00`).getTime() - Date.now()) / (7 * 86_400_000)) : null;
      lines.push(`- ${r.name}${r.raceDate ? ` on ${weekday(r.raceDate)} ${r.raceDate} (${weeks} weeks away)` : " (date not set)"}${r.distanceMi ? `, ${r.distanceMi.toFixed(1)}mi` : ""}${r.notes ? ` — notes: ${r.notes}` : ""}`);
    }
  }
  if (done.length) {
    lines.push("## Recent races");
    for (const r of done) lines.push(`- ${r.name}${r.raceDate ? ` (${r.raceDate})` : ""}${r.distanceMi ? `, ${r.distanceMi.toFixed(1)}mi` : ""}${r.notes ? ` — ${r.notes}` : ""}`);
  }
  return lines;
}

function profileSection(acts: ActivityRow[], zones: HrZones | null): string[] {
  const latest = acts.find(a => isRun(a) && a.hrz_1_hr != null);
  const vo2 = acts.find(a => isRun(a) && a.vo2_max != null)?.vo2_max;
  const lines: string[] = [];
  if (zones) {
    const extra = [
      zones.maxHr != null ? `max HR ${zones.maxHr}` : "",
      zones.lthr != null ? `lactate threshold HR ${zones.lthr}` : "",
      zones.restingHr != null ? `resting HR ${zones.restingHr}` : "",
    ].filter(Boolean).join(", ");
    lines.push(`- Heart-rate zones (current Garmin Connect running zones; all zone figures below use these): ${zonesText(zones)}${extra ? `; ${extra}` : ""}`);
  } else if (latest) {
    const b = [latest.hrz_1_hr, latest.hrz_2_hr, latest.hrz_3_hr, latest.hrz_4_hr, latest.hrz_5_hr];
    lines.push(`- Garmin HR zone floors (bpm): Z1 ${b[0]}, Z2 ${b[1]}, Z3 ${b[2]}, Z4 ${b[3]}, Z5 ${b[4]}`);
  }
  if (vo2 != null) lines.push(`- Garmin VO2max estimate: ${vo2}`);
  return lines.length ? ["## Athlete profile", ...lines] : [];
}

export async function buildCoachContext(): Promise<CoachContext> {
  const since = localDate(new Date(Date.now() - WEEKS * 7 * 86_400_000));
  const acts = loadActivities(since);
  const schedule = await fetchRunnaSchedule().catch(() => null);
  const workouts = schedule?.ok ? schedule.workouts : [];
  const pastRuns = schedule?.ok ? schedule.pastRuns : [];
  const zones = await getCurrentHrZones().catch(() => null);
  const [recent, hrv, dayBy] = await Promise.all([
    recentRunsSection(acts, pastRuns, zones),
    getHrvDays(localDate(new Date(Date.now() - 7 * 86_400_000)), localDate(new Date())).catch(() => new Map<string, HrvDay>()),
    dayByDaySection(acts, pastRuns, workouts),
  ]);

  const sections = [
    profileSection(acts, zones),
    racesSection(),
    upcomingSection(workouts),
    dayBy,
    recent.lines,
    otherTrainingSection(acts),
    weeklySection(acts),
    wellnessSection(hrv),
  ].filter(s => s.length);

  if (!acts.length) sections.unshift(["(No GarminDB activity data is available — say so if the athlete asks about their recent training.)"]);
  if (!schedule?.ok) sections.push(["(The Runna training plan couldn't be loaded right now.)"]);

  return {
    text: sections.map(s => s.join("\n")).join("\n\n"),
    generatedAt: new Date().toISOString(),
    runCount: recent.count,
  };
}

// Run after every GarminDB sync (scripts/garmin_after_sync.sh →
// /api/coach/refresh-data): reads laps for every run in the coach's window,
// fetches run weather and refreshes HRV, so it's all stored before the
// Coach next asks for it.
export async function prefetchCoachData(): Promise<{ runs: number; laps: number; weather: number; hrvDays: number }> {
  const cutoff = localDate(new Date(Date.now() - RECENT_RUN_DAYS * 86_400_000));
  const runs = loadActivities(cutoff).filter(isRun);
  // Fresh zones from Garmin, then time-in-zone for every run against them.
  const zones = await getCurrentHrZones(true).catch(() => null);
  if (zones) getZoneSplits(runs.map(r => String(r.activity_id)), zones);
  const [laps, weather, hrv] = await Promise.all([
    getRunLaps(runs.map(r => String(r.activity_id))),
    Promise.all(runs.slice(0, WEATHER_RUNS).map(runWeather)),
    getHrvDays(localDate(new Date(Date.now() - 7 * 86_400_000)), localDate(new Date()), true).catch(() => new Map<string, HrvDay>()),
  ]);
  return { runs: runs.length, laps: laps.size, weather: weather.filter(Boolean).length, hrvDays: hrv.size };
}
