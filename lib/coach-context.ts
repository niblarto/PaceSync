import path from "path";
import { getDb } from "@/lib/db";
import { loadGarminConfig } from "@/lib/garmin-config";
import { fetchRunnaSchedule, type RunnaPastRun, type RunnaWorkout } from "@/lib/runna-schedule";
import { listRaces } from "@/lib/races";
import { getDayRecovery, refreshTodayBurn } from "@/lib/garmin-connect";
import { buildNutritionDashboard, type NutritionDashboard } from "@/lib/nutrition-dashboard";
import { formatWeight, formatWeightDelta } from "@/lib/weight-format";
import { listRunFeedback, effortLabel, FEEL_LABELS, type RunFeedback } from "@/lib/run-feedback";
import { formatLaps, getCurrentHrZones, type FitLap, getHrvDays, getRunLaps, getZoneSplits, isStructured, zonesText, type HrvDay, type HrZones } from "@/lib/coach-garmin-extra";

// The training brief the Coach reads before every reply: who the athlete
// is right now (load, recovery, recent runs with weather), what's planned
// and what they're training for. Plain text, units in miles — it goes
// straight into the model's system prompt.

const RECENT_RUN_DAYS = 28;
const WEEKS = 12;
const DETAIL_DAYS = 7; // full day-by-day detail; older runs are one-liners

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

// Recovery figures per day (resting HR, sleep, HRV, stress, body battery),
// merged into that day's DAY BY DAY entry.
function recoveryByDay(hrvApi: Map<string, HrvDay>, since: string): Map<string, string> {
  const out = new Map<string, string>();
  const db = openGarmin("garmin.db");
  if (!db) return out;
  try {
    const days = db.prepare(`
      SELECT DATE(d.day) AS day, d.rhr, d.stress_avg, d.bb_max, s.total_sleep, s.score AS sleep_score, s.qualifier,
             h.last_night_avg AS hrv, h.status AS hrv_status
      FROM daily_summary d
      LEFT JOIN sleep s ON DATE(s.day) = DATE(d.day)
      LEFT JOIN hrv h ON DATE(h.day) = DATE(d.day)
      WHERE DATE(d.day) >= ?
    `).all(since) as { day: string; rhr: number | null; stress_avg: number | null; bb_max: number | null; total_sleep: string | null; sleep_score: number | null; qualifier: string | null; hrv: number | null; hrv_status: string | null }[];
    for (const d of days) {
      const h = hrvApi.get(d.day); // GarminDB's HRV table is empty; prefer the Personal API's
      const hrv = h?.lastNightAvg != null
        ? `HRV ${h.lastNightAvg}ms (7-day avg ${h.weeklyAvg ?? "-"}${h.balancedLow != null && h.balancedUpper != null ? `, baseline ${h.balancedLow}-${h.balancedUpper}` : ""}${h.status ? `, ${h.status.toLowerCase()}` : ""})`
        : d.hrv != null ? `HRV ${d.hrv}${d.hrv_status ? ` ${d.hrv_status.toLowerCase()}` : ""}` : "";
      const parts = [
        d.rhr != null ? `resting HR ${d.rhr}` : "",
        d.total_sleep ? `sleep ${clock(secs(d.total_sleep)).replace(/:\d\d$/, "")}h${d.sleep_score != null ? ` (score ${d.sleep_score}${d.qualifier ? ` ${d.qualifier.toLowerCase()}` : ""})` : ""}` : "",
        hrv,
        d.stress_avg != null ? `stress ${d.stress_avg}` : "",
        d.bb_max != null ? `body battery max ${d.bb_max}` : "",
      ].filter(Boolean);
      if (parts.length) out.set(d.day, parts.join(", "));
    }
  } catch {} finally {
    db.close();
  }
  return out;
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

// "Rushcliffe - W6 Tue Easy Run - 4.5mi Easy Run (" → "4.5mi Easy Run"
function cleanRunName(name: string | null): string {
  if (!name) return "Run";
  const last = name.split(" - ").pop() ?? name;
  return last.replace(/\s*\([^)]*$/, "").trim() || "Run"; // drop a cut-off "(..." tail
}

function ratingText(fb: RunFeedback | undefined): string {
  if (!fb) return "";
  const rated = [
    fb.effort != null ? `effort ${fb.effort}/10 (${effortLabel(fb.effort)})` : "",
    fb.feel != null ? `felt ${FEEL_LABELS[fb.feel - 1].toLowerCase()} (${fb.feel}/5)` : "",
  ].filter(Boolean).join(", ");
  return `${rated || "no score"}${fb.notes ? `; notes: "${fb.notes.replace(/\s+/g, " ")}"` : ""}`;
}

// The athlete's post-run rating for a run; if two runs share a date, prefer
// the one whose title matches.
function feedbackFor(all: RunFeedback[], date: string, title: string): RunFeedback | undefined {
  const fbs = all.filter(f => f.date === date);
  return fbs.find(f => f.title === title) ?? (fbs.length === 1 ? fbs[0] : undefined);
}

// Runs before the DAY BY DAY window, one line each (the last 7 days are in
// full there).
function earlierRunsSection(acts: ActivityRow[], pastRuns: RunnaPastRun[], zones: HrZones | null, feedback: RunFeedback[]): string[] {
  const cutoff = localDate(new Date(Date.now() - RECENT_RUN_DAYS * 86_400_000));
  const detailStart = localDate(new Date(Date.now() - (DETAIL_DAYS - 1) * 86_400_000));
  const runs = acts.filter(a => isRun(a) && a.start_time.slice(0, 10) >= cutoff && a.start_time.slice(0, 10) < detailStart);
  if (!runs.length) return [];
  const byDate = new Map(pastRuns.map(p => [p.date, p]));
  const splits = zones ? getZoneSplits(runs.map(r => String(r.activity_id)), zones) : new Map<string, number[]>();
  const lines = [`## Earlier runs — ${detailStart > cutoff ? `days ${DETAIL_DAYS + 1}-${RECENT_RUN_DAYS}` : ""} (newest first)`];
  for (const r of runs) {
    const date = r.start_time.slice(0, 10);
    const sec = secs(r.moving_time ?? r.elapsed_time);
    const plan = byDate.get(date);
    const title = plan && plan.type !== "rest" && !plan.uid.startsWith("GARMIN_") ? plan.title : cleanRunName(r.name);
    const parts = [
      `${(r.distance ?? 0).toFixed(2)}mi, ${clock(sec)}, ${pace(sec, r.distance)}`,
      r.avg_hr != null ? `HR ${r.avg_hr}/${r.max_hr ?? "-"}` : "",
      r.training_load != null ? `load ${Math.round(r.training_load)}` : "",
      zoneSplit(r, splits.get(String(r.activity_id))),
    ].filter(Boolean);
    const rating = ratingText(feedbackFor(feedback, date, plan?.title ?? title));
    lines.push(`- ${weekday(date)} ${date} — ${title}: ${parts.join("; ")}${rating ? `; rating ${rating}` : ""}`);
  }
  return lines;
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

// Runna step lists start with a header ("Long Run • 11mi • 1h30m - 1h40m")
// that repeats the title; drop it.
function planSteps(steps: string[]): string[] {
  return steps.filter((st, i) => !(i === 0 && st.includes(" • ") && !st.trim().startsWith("•")));
}

// Everything for each of the last 7 days (today included) in one entry:
// plan (Runna), what was done (Garmin) with run detail, rating and judged
// splits, recovery, and food. Built here so the coach doesn't have to infer
// or cross-reference anything.
async function dayByDaySection(
  acts: ActivityRow[], pastRuns: RunnaPastRun[], workouts: RunnaWorkout[], nutrition: NutritionDashboard | null,
  zones: HrZones | null, recovery: Map<string, string>, feedback: RunFeedback[],
): Promise<string[]> {
  const food = new Map((nutrition?.days ?? []).map(d => [d.date, d]));
  const today = localDate(new Date());
  const weekStart = localDate(new Date(Date.now() - (DETAIL_DAYS - 1) * 86_400_000));
  const anyFood = (nutrition?.days ?? []).some(d => d.date >= weekStart && d.eaten != null);
  const weekRuns = acts.filter(a => isRun(a) && a.start_time.slice(0, 10) >= weekStart);
  const [watchLaps, weather] = await Promise.all([
    getRunLaps(weekRuns.map(r => String(r.activity_id))).catch(() => new Map<string, FitLap[]>()),
    Promise.all(weekRuns.map(r => runWeather(r).catch(() => null))),
  ]);
  const weatherById = new Map(weekRuns.map((r, i) => [String(r.activity_id), weather[i]]));
  const zoneById = zones ? getZoneSplits(weekRuns.map(r => String(r.activity_id)), zones) : new Map<string, number[]>();

  const lines = [`## Day by day — last ${DETAIL_DAYS} days (plan from Runna, actual from Garmin). Complete: use it for plan vs actual.`];
  for (let i = DETAIL_DAYS - 1; i >= 0; i--) {
    const date = localDate(new Date(Date.now() - i * 86_400_000));
    const past = pastRuns.find(p => p.date === date);
    const upcoming = workouts.find(w => w.date === date);
    const plannedPast = past && past.type !== "rest" && !past.uid.startsWith("GARMIN_WALK_") && !past.uid.startsWith("SYNTHETIC_REST_");
    const steps = planSteps(plannedPast ? past!.planSteps : upcoming?.segments ?? []);
    const dayActs = acts.filter(a => a.start_time.slice(0, 10) === date).sort((a, b) => a.start_time.localeCompare(b.start_time));

    // Judged splits per run; when present they already carry the plan's
    // targets, so the plan line doesn't repeat the steps.
    const runBlocks: string[] = [];
    let judgedAny = false;
    for (const a of dayActs) {
      const sec = secs(a.moving_time ?? a.elapsed_time);
      if (!isRun(a)) {
        const bits = [
          a.distance ? `${a.distance.toFixed(2)}mi` : "",
          clock(sec),
          a.avg_hr != null ? `HR ${a.avg_hr}/${a.max_hr ?? "-"}` : "",
          a.training_load != null ? `load ${Math.round(a.training_load)}` : "",
        ].filter(Boolean);
        runBlocks.push(`  DONE: ${sportLabel(a)} ${a.start_time.slice(11, 16)} (${bits.join(", ")})`);
        continue;
      }
      const id = String(a.activity_id);
      const detail = [
        `${(a.distance ?? 0).toFixed(2)}mi in ${clock(sec)} (${pace(sec, a.distance)})`,
        a.avg_hr != null ? `HR avg ${a.avg_hr}/max ${a.max_hr ?? "-"}` : "",
        a.spm != null ? `cadence ${Math.round(a.spm)}spm` : "",
        a.ascent ? `ascent ${Math.round(a.ascent)}ft` : "",
        a.training_effect != null ? `training effect aerobic ${a.training_effect}/anaerobic ${a.anaerobic_training_effect ?? 0}` : "",
        a.training_load != null ? `load ${Math.round(a.training_load)}` : "",
        zoneSplit(a, zoneById.get(id)),
        weatherText(weatherById.get(id)),
      ].filter(Boolean);
      runBlocks.push(`  DONE: Run ${a.start_time.slice(11, 16)}: ${detail.join("; ")}`);
      const rating = ratingText(feedbackFor(feedback, date, plannedPast ? past!.title : cleanRunName(a.name)));
      if (rating) runBlocks.push(`  RATING: ${rating}`);

      const laps = watchLaps.get(id);
      const judged = past?.laps.length ? judgeSegments(steps, past.laps, laps) : null;
      if (laps && isStructured(laps) && laps.length > 1 && steps.length) {
        runBlocks.push(`  SPLITS vs PLAN: ${judgeWorkoutLaps(steps, laps)}`);
        judgedAny = true;
      } else if (judged) {
        runBlocks.push(`  SPLITS vs PLAN: ${judged}`);
        judgedAny = true;
      } else if (laps && laps.length > 1) {
        runBlocks.push(`  SPLITS: ${formatLaps(laps)}`);
      } else if (past?.laps.length) {
        runBlocks.push(`  SPLITS: ${past.laps.join(" | ")}`);
      }
    }

    let plan: string;
    if (plannedPast) {
      plan = past!.uid.startsWith("GARMIN_ORPHAN_") ? `${past!.title} (from the Garmin activity name)` : past!.title;
    } else if (upcoming && upcoming.type !== "rest") {
      plan = upcoming.title + (upcoming.distanceMi ? ` (${upcoming.distanceMi.toFixed(1)}mi)` : "");
    } else {
      plan = "Rest day";
    }
    if (steps.length && !judgedAny && plan !== "Rest day") plan += ` — steps: ${steps.join(" | ")}`;

    lines.push(`- ${weekday(date)} ${date}${date === today ? " (TODAY)" : ""} — PLAN: ${plan}`);
    if (runBlocks.length) lines.push(...runBlocks);
    else lines.push(`  DONE: nothing${date === today ? " yet today" : ""}`);
    const rec = recovery.get(date);
    if (rec) lines.push(`  RECOVERY: ${rec}`);
    if (anyFood) {
      const f = food.get(date);
      lines.push(f?.eaten == null
        ? "  FOOD: not logged"
        : `  FOOD: eaten ${f.eaten} kcal${f.proteinG != null ? ` (P ${Math.round(f.proteinG)}g C ${Math.round(f.carbsG ?? 0)}g F ${Math.round(f.fatG ?? 0)}g)` : ""}`
          + (f.burnt != null ? `, burnt ${f.burnt}${f.partial ? " so far" : ""}, net ${f.net! > 0 ? "+" : ""}${f.net}${f.partial ? " so far" : ""}` : date === today ? " so far" : ""));
    }
  }
  return lines;
}

// Weight goal, trend and fuelling (Lose It! food via Health Connect,
// Garmin burn and weigh-ins), from the Nutrition page's data.
function nutritionSection(n: NutritionDashboard | null): string[] {
  if (!n) return [];
  const c = n.config;
  const u = c.weightUnit;
  const lines = ["## Weight & nutrition (food from Lose It!, burn and weigh-ins from Garmin)"];
  if (n.current) {
    const c0 = n.current;
    lines.push(`- Latest weight: ${formatWeight(c0.kg, u)} (${c0.kg.toFixed(1)} kg) on ${c0.date}${c0.postRun ? " — a post-run weigh-in, which reads light from sweat" : ""}; 7-day average ${formatWeight(c0.avg7Kg, u)}${c0.postRun ? `; latest regular (pre-breakfast) weight ${formatWeight(c0.regularKg, u)} on ${c0.regularDate}` : ""}`);
  }
  const goal = [
    c.targetWeightKg != null ? `target ${formatWeight(c.targetWeightKg, u)}` : "",
    c.goalDate ? `by ${c.goalDate}` : "",
    c.dailyCalorieLimit != null ? `daily calorie limit ${c.dailyCalorieLimit} kcal eaten` : "",
  ].filter(Boolean);
  if (goal.length) lines.push(`- Goal: ${goal.join(", ")}. Maximum safe loss rate: 2 lb/week.`);
  if (n.required) lines.push(`- Needed to hit the goal on time: ${formatWeightDelta(n.required.kgPerWeek, u)}/week (daily balance ${n.required.dailyBalance} kcal${n.required.intake != null ? `, about ${n.required.intake} kcal eaten/day` : ""})`);
  const a = n.averages;
  const burn = `avg burnt ${a.burnt != null ? Math.round(a.burnt) : "?"} kcal/day (exercise ${a.exercise != null ? Math.round(a.exercise) : "?"})`;
  lines.push(a.loggedDays
    ? `- Last ${a.windowDays} days (excluding today): ${a.loggedDays} days with food logged; avg eaten ${Math.round(a.eaten!)} kcal, ${burn}, avg net ${Math.round(a.net!)} (eaten − burnt; negative = deficit)`
    : `- Last ${a.windowDays} days: no food logged yet; ${burn}`);
  for (const p of n.projections) {
    const hit = p.hitStatus === "reached" ? "already reached" : p.hitStatus === "on-course" ? `reached ${p.hitDate}` : "not reached at this rate";
    lines.push(`- Projection, ${p.label} (${p.basis}): ${formatWeightDelta(p.kgPerWeek, u)}/week; target ${hit}${p.weightAtGoalKg != null ? `; ${formatWeight(p.weightAtGoalKg, u)} on the goal date` : ""}`);
  }
  return lines;
}

function upcomingSection(workouts: RunnaWorkout[]): string[] {
  // Today is in DAY BY DAY, so this starts tomorrow.
  const tomorrow = localDate(new Date(Date.now() + 86_400_000));
  const until = localDate(new Date(Date.now() + 10 * 86_400_000));
  const next = workouts.filter(w => w.date >= tomorrow && w.date <= until).sort((a, b) => a.date.localeCompare(b.date));
  if (!next.length) return [];
  const lines = ["## Planned sessions — next 10 days from tomorrow (Runna plan)"];
  for (const w of next) {
    if (w.type === "rest") { lines.push(`- ${weekday(w.date)} ${w.date} — Rest`); continue; }
    const steps = planSteps(w.segments);
    lines.push(`- ${weekday(w.date)} ${w.date} — ${w.title}${w.distanceMi ? ` (${w.distanceMi.toFixed(1)}mi)` : ""}${steps.length ? `: ${steps.slice(0, 14).join(" | ")}` : ""}`);
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
      // Exact calendar days, so the coach never has to work it out.
      let away = "";
      if (r.raceDate) {
        const days = Math.round((new Date(`${r.raceDate}T12:00:00`).getTime() - new Date(`${today}T12:00:00`).getTime()) / 86_400_000);
        const w = Math.floor(days / 7), d = days % 7;
        away = days === 0 ? "TODAY" : `in ${days} days = ${w} week${w === 1 ? "" : "s"}${d ? ` ${d} day${d === 1 ? "" : "s"}` : ""}`;
      }
      lines.push(`- ${r.name}${r.raceDate ? ` on ${weekday(r.raceDate)} ${r.raceDate} (${away})` : " (date not set)"}${r.distanceMi ? `, ${r.distanceMi.toFixed(1)}mi` : ""}${r.notes ? ` — notes: ${r.notes}` : ""}`);
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

export interface FortnightFacts {
  /** The Training bullet, written from the data (not by the AI). */
  trainingLine: string;
  /** The Recovery bullet (sleep, resting HR, load), also from the data; "" if there is none. */
  recoveryLine: string;
  /** The same figures as a block for the AI's prompt. */
  text: string;
  runs: number;
  miles: number;
}

// The last 14 days (today and the 13 before) added up in code. A language
// model can't be trusted to total distances scattered across a long context
// (it only gets full detail for the last 7 days), so the dashboard's two-week
// summary states these figures itself.
export function fortnightFacts(now = new Date()): FortnightFacts {
  const end = localDate(now);
  const start = localDate(new Date(now.getTime() - 13 * 86_400_000));
  const lastWeekStart = localDate(new Date(now.getTime() - 6 * 86_400_000));
  const acts = loadActivities(start).filter(a => a.start_time.slice(0, 10) <= end);
  const runs = acts.filter(isRun);
  const miles = (xs: ActivityRow[]) => xs.reduce((sum, a) => sum + (a.distance ?? 0), 0);
  const runMi = miles(runs);
  const runSec = runs.reduce((sum, a) => sum + secs(a.moving_time ?? a.elapsed_time), 0);
  const recent = runs.filter(r => r.start_time.slice(0, 10) >= lastWeekStart);
  const before = runs.filter(r => r.start_time.slice(0, 10) < lastWeekStart);
  const longest = runs.reduce((m, a) => Math.max(m, a.distance ?? 0), 0);
  const load = Math.round(runs.reduce((sum, a) => sum + (a.training_load ?? 0), 0));

  // Everything that isn't a run, grouped: walks (with distance) and the rest by type.
  const others = acts.filter(a => !isRun(a));
  const walks = others.filter(a => (a.sport ?? "").toLowerCase().includes("walk"));
  const rest = others.filter(a => !walks.includes(a));
  const restLabel = (a: ActivityRow) => ((a.sport ?? "").toLowerCase() === "fitness_equipment" ? a.sub_sport : a.sport) ?? "other";
  const restCounts = new Map<string, number>();
  for (const a of rest) {
    const k = restLabel(a).replace(/_/g, " ");
    restCounts.set(k, (restCounts.get(k) ?? 0) + 1);
  }
  const alsoParts: string[] = [];
  if (walks.length) alsoParts.push(`${walks.length} walk${walks.length === 1 ? "" : "s"} (${miles(walks).toFixed(1)}mi)`);
  restCounts.forEach((n, k) => alsoParts.push(`${n} ${k}`));
  const also = alsoParts.length ? ` Also ${alsoParts.join(", ")}.` : "";

  // Sleep and resting HR for the same 14 days, from GarminDB.
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const recParts: string[] = [];
  const gdb = openGarmin("garmin.db");
  if (gdb) {
    try {
      const rows = gdb.prepare(`
        SELECT DATE(d.day) AS day, d.rhr, s.total_sleep, s.score, s.qualifier
        FROM daily_summary d LEFT JOIN sleep s ON DATE(s.day) = DATE(d.day)
        WHERE DATE(d.day) >= ? AND DATE(d.day) <= ?
      `).all(start, end) as { day: string; rhr: number | null; total_sleep: string | null; score: number | null; qualifier: string | null }[];
      const scores = rows.map(r => r.score).filter((x): x is number => x != null);
      if (scores.length) {
        const poor = rows.filter(r => (r.qualifier ?? "").toUpperCase() === "POOR").length;
        const sleepAvg = avg(rows.filter(r => r.total_sleep).map(r => secs(r.total_sleep)));
        const hm = sleepAvg ? `${Math.floor(sleepAvg / 3600)}h${String(Math.round((sleepAvg % 3600) / 60)).padStart(2, "0")}` : null;
        recParts.push(`sleep score averaged ${Math.round(avg(scores)!)} (range ${Math.min(...scores)}–${Math.max(...scores)}; ${poor} of ${scores.length} nights rated poor)${hm ? `, ${hm} a night` : ""}`);
      }
      const rhrNow = avg(rows.filter(r => r.day >= lastWeekStart && r.rhr != null).map(r => r.rhr as number));
      const rhrBefore = avg(rows.filter(r => r.day < lastWeekStart && r.rhr != null).map(r => r.rhr as number));
      if (rhrNow != null && rhrBefore != null) recParts.push(`resting HR ${rhrNow.toFixed(0)} in the last 7 days vs ${rhrBefore.toFixed(0)} the 7 before`);
    } catch {} finally {
      gdb.close();
    }
  }
  const loadOf = (xs: ActivityRow[]) => Math.round(xs.reduce((sum, a) => sum + (a.training_load ?? 0), 0));
  if (runs.length) recParts.push(`running load ${loadOf(recent)} in the last 7 days vs ${loadOf(before)} the 7 before`);
  const recoveryLine = recParts.length ? `**Recovery:** ${recParts.join("; ")}.` : "";

  const trainingLine = runs.length === 0
    ? `**Training:** no runs in the last 14 days.${also}`
    : `**Training:** ${runs.length} run${runs.length === 1 ? "" : "s"}, ${runMi.toFixed(1)}mi in 14 days (last 7 days ${miles(recent).toFixed(1)}mi in ${recent.length}, the 7 before ${miles(before).toFixed(1)}mi in ${before.length}); longest ${longest.toFixed(1)}mi, average pace ${pace(runSec, runMi)}.${also}`;

  const lines = [
    `## TWO-WEEK TOTALS (${start} to ${end}, 14 days) — added up by the app, so they are exact`,
    `- Runs: ${runs.length}, ${runMi.toFixed(2)}mi in total, moving time ${clock(runSec)}, average pace ${pace(runSec, runMi)}, longest ${longest.toFixed(2)}mi, training load ${load}`,
    `- Last 7 days (${lastWeekStart} to ${end}): ${recent.length} runs, ${miles(recent).toFixed(2)}mi. The 7 days before (${start} to ${localDate(new Date(now.getTime() - 7 * 86_400_000))}): ${before.length} runs, ${miles(before).toFixed(2)}mi`,
    ...(alsoParts.length ? [`- Other sessions: ${alsoParts.join(", ")}`] : []),
    ...(recParts.length ? [`- Recovery: ${recParts.join("; ")}`] : []),
    "- Runs, newest first:",
    ...runs.map(r => `  - ${weekday(r.start_time.slice(0, 10))} ${r.start_time.slice(0, 10)}: ${(r.distance ?? 0).toFixed(2)}mi, ${pace(secs(r.moving_time ?? r.elapsed_time), r.distance)}`),
  ];
  return { trainingLine, recoveryLine, text: lines.join("\n"), runs: runs.length, miles: runMi };
}

export async function buildCoachContext(): Promise<CoachContext> {
  const since = localDate(new Date(Date.now() - WEEKS * 7 * 86_400_000));
  const acts = loadActivities(since);
  const schedule = await fetchRunnaSchedule().catch(() => null);
  const workouts = schedule?.ok ? schedule.workouts : [];
  const pastRuns = schedule?.ok ? schedule.pastRuns : [];
  const zones = await getCurrentHrZones().catch(() => null);
  let nutrition: NutritionDashboard | null = null;
  await refreshTodayBurn(localDate(new Date())).catch(() => null);
  try { nutrition = buildNutritionDashboard(14); } catch {}
  const detailStart = localDate(new Date(Date.now() - (DETAIL_DAYS - 1) * 86_400_000));
  const feedback = listRunFeedback(localDate(new Date(Date.now() - RECENT_RUN_DAYS * 86_400_000)));
  const hrv = await getHrvDays(detailStart, localDate(new Date())).catch(() => new Map<string, HrvDay>());
  const recovery = recoveryByDay(hrv, detailStart);
  // GarminDB only stores a day once it's over, so today's recovery (last
  // night's sleep, this morning's resting HR) comes straight from Garmin.
  const todayDate = localDate(new Date());
  if (!recovery.has(todayDate)) {
    const r = await getDayRecovery(todayDate).catch(() => null);
    if (r) {
      const parts = [
        r.restingHr != null ? `resting HR ${r.restingHr}` : "",
        r.sleepSec != null ? `sleep ${clock(r.sleepSec).replace(/:\d\d$/, "")}h${r.sleepScore != null ? ` (score ${r.sleepScore}${r.sleepQualifier ? ` ${r.sleepQualifier.toLowerCase()}` : ""})` : ""}` : "",
        r.hrv != null ? `HRV ${Math.round(r.hrv)}ms${r.hrvStatus ? ` (${r.hrvStatus.toLowerCase()})` : ""}` : "",
        r.stressAvg != null ? `stress ${r.stressAvg} so far` : "",
        r.bodyBatteryMax != null ? `body battery max ${r.bodyBatteryMax}` : "",
      ].filter(Boolean);
      if (parts.length) recovery.set(todayDate, parts.join(", "));
    }
  }
  const dayBy = await dayByDaySection(acts, pastRuns, workouts, nutrition, zones, recovery, feedback);
  const cutoff = localDate(new Date(Date.now() - RECENT_RUN_DAYS * 86_400_000));
  const runCount = acts.filter(a => isRun(a) && a.start_time.slice(0, 10) >= cutoff).length;

  const sections = [
    profileSection(acts, zones),
    racesSection(),
    dayBy,
    upcomingSection(workouts),
    earlierRunsSection(acts, pastRuns, zones, feedback),
    weeklySection(acts),
    nutritionSection(nutrition),
  ].filter(s => s.length);

  if (!acts.length) sections.unshift(["(No GarminDB activity data is available — say so if the athlete asks about their recent training.)"]);
  if (!schedule?.ok) sections.push(["(The Runna training plan couldn't be loaded right now.)"]);

  return {
    text: sections.map(s => s.join("\n")).join("\n\n"),
    generatedAt: new Date().toISOString(),
    runCount,
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
    // Weather is only shown for runs in the DAY BY DAY window.
    Promise.all(runs.filter(r => r.start_time.slice(0, 10) >= localDate(new Date(Date.now() - (DETAIL_DAYS - 1) * 86_400_000))).map(runWeather)),
    getHrvDays(localDate(new Date(Date.now() - 7 * 86_400_000)), localDate(new Date()), true).catch(() => new Map<string, HrvDay>()),
  ]);
  return { runs: runs.length, laps: laps.size, weather: weather.filter(Boolean).length, hrvDays: hrv.size };
}
