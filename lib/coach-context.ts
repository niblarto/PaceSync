import path from "path";
import { getDb } from "@/lib/db";
import { loadGarminConfig } from "@/lib/garmin-config";
import { fetchRunnaSchedule, type RunnaPastRun, type RunnaWorkout } from "@/lib/runna-schedule";
import { listRaces } from "@/lib/races";
import { listRunFeedback, effortLabel, FEEL_LABELS, type RunFeedback } from "@/lib/run-feedback";
import { formatLaps, getCurrentHrZones, getHrvDays, getRunLaps, getZoneSplits, isStructured, zonesText, type HrvDay, type HrZones } from "@/lib/coach-garmin-extra";

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
      SELECT a.activity_id, a.name, a.sport, a.start_time, a.elapsed_time, a.moving_time, a.distance,
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
  const lines = [`## Weekly running volume — last ${WEEKS} weeks (Mon-Sun, current week partial)`];
  for (const [w, e] of Array.from(weeks.entries()).sort((a, b) => b[0].localeCompare(a[0]))) {
    lines.push(`- w/c ${w}: ${e.runs} runs, ${e.mi.toFixed(1)}mi, ${clock(e.sec)}, longest ${e.long.toFixed(1)}mi, training load ${Math.round(e.load)}`);
  }
  return lines;
}

async function recentRunsSection(acts: ActivityRow[], pastRuns: RunnaPastRun[], zones: HrZones | null): Promise<{ lines: string[]; count: number }> {
  const cutoff = localDate(new Date(Date.now() - RECENT_RUN_DAYS * 86_400_000));
  const runs = acts.filter(a => isRun(a) && a.start_time.slice(0, 10) >= cutoff);
  const walks = acts.filter(a => (a.sport ?? "").toLowerCase().includes("walk") && a.start_time.slice(0, 10) >= cutoff);
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
  if (walks.length) {
    const mi = walks.reduce((s, w) => s + (w.distance ?? 0), 0);
    lines.push(`- Also ${walks.length} walk${walks.length === 1 ? "" : "s"} (${mi.toFixed(1)}mi total) in this period.`);
  }
  return { lines, count: runs.length };
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
  const [recent, hrv] = await Promise.all([
    recentRunsSection(acts, pastRuns, zones),
    getHrvDays(localDate(new Date(Date.now() - 7 * 86_400_000)), localDate(new Date())).catch(() => new Map<string, HrvDay>()),
  ]);

  const sections = [
    profileSection(acts, zones),
    racesSection(),
    upcomingSection(workouts),
    recent.lines,
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
