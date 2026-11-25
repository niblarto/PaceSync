import path from "path";
import { loadGarminConfig } from "@/lib/garmin-config";
import { getDb } from "@/lib/db";
import { buildHealthDashboard, type HealthDay } from "@/lib/health-dashboard";
import { buildNutritionDashboard } from "@/lib/nutrition-dashboard";
import { LB_PER_KG } from "@/lib/weight-format";

// The Metrics page (/metrics): a Grafana-style view of running and health data, read from the sources PaceSync already
// has — GarminDB (daily summary, heart rate, stress, activities), the Garmin API (HRV, via the Health dashboard),
// and the Lose It! food diary. Thin slice: a window of 7-30 days.

type Row = Record<string, unknown>;

export interface MetricsDay {
  date: string;
  steps: number | null; stepGoal: number | null; distanceMi: number | null;
  rhr: number | null; hrMin: number | null; hrMax: number | null;
  stressAvg: number | null; bbMax: number | null; bbMin: number | null;
  spo2Avg: number | null; rrAvg: number | null;
  caloriesTotal: number | null; caloriesActive: number | null; caloriesBmr: number | null;
  moderateMin: number | null; vigorousMin: number | null;
  weightLb: number | null;
  kcalIn: number | null; proteinG: number | null; carbsG: number | null; fatG: number | null;
}

export interface MetricsActivity {
  id: string; date: string; startTime: string; sport: string; name: string | null;
  distanceMi: number | null; movingSec: number | null; paceSec: number | null;
  avgHr: number | null; maxHr: number | null; cadence: number | null; ascentFt: number | null;
  trainingEffect: number | null; anaerobicEffect: number | null; trainingLoad: number | null; zoneSec: number[]; // time in HR zones 1-5
}

export interface HeatCell { date: string; hour: number; value: number }

export interface MetricsOverview {
  from: string; to: string;
  days: MetricsDay[];
  health: HealthDay[];             // sleep, HRV, resting HR — shared with the Health page
  activities: MetricsActivity[];
  hrHeat: HeatCell[];              // average heart rate by day and hour
  stressHeat: HeatCell[];          // average stress by day and hour
  weight: { kg: number; date: string; avg7Kg: number; postRun: boolean } | null; // current weight, as on the Nutrition tab
}

export interface DayPoint { t: string; hr: number | null; stress: number | null }
export interface MetricsDayDetail { date: string; points: DayPoint[]; activities: MetricsActivity[] }

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

// GarminDB stores durations as clock times: "00:08:04.013289".
function secs(v: unknown): number | null {
  const m = String(v ?? "").match(/^(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const r1 = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10);

function openGarmin(file: string) {
  const config = loadGarminConfig();
  if (!config) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(path.join(config.dbPath, file), { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 30000");
    return db;
  } catch { return null; }
}

function activityOf(r: Row): MetricsActivity {
  const start = String(r.start_time ?? "");
  const moving = secs(r.moving_time);
  const dist = num(r.distance);
  return {
    id: String(r.activity_id), date: start.slice(0, 10), startTime: start.slice(0, 19), sport: String(r.sport ?? ""), name: (r.name as string) ?? null,
    distanceMi: r1(dist), movingSec: moving,
    paceSec: secs(r.avg_moving_pace) ?? (dist && moving ? moving / dist : null),
    avgHr: num(r.avg_hr), maxHr: num(r.max_hr), cadence: num(r.avg_steps_per_min) ?? num(r.avg_cadence),
    ascentFt: num(r.ascent) != null ? Math.round(num(r.ascent)! * 3.28084) : null,
    trainingEffect: r1(num(r.training_effect)), anaerobicEffect: r1(num(r.anaerobic_training_effect)), trainingLoad: num(r.training_load) != null ? Math.round(num(r.training_load)!) : null,
    zoneSec: [1, 2, 3, 4, 5].map(z => secs(r[`hrz_${z}_time`]) ?? 0),
  };
}

const ACTIVITY_SQL = `
  SELECT a.activity_id, a.name, a.sport, a.start_time, a.moving_time, a.distance, a.avg_hr, a.max_hr, a.avg_cadence, a.ascent,
         a.training_effect, a.anaerobic_training_effect, a.training_load, a.hrz_1_time, a.hrz_2_time, a.hrz_3_time, a.hrz_4_time, a.hrz_5_time,
         s.avg_steps_per_min, s.avg_moving_pace
  FROM activities a LEFT JOIN steps_activities s ON s.activity_id = a.activity_id`;

export async function buildMetricsOverview(numDays = 14): Promise<MetricsOverview> {
  const to = ymd(new Date());
  const from = addDays(to, -(numDays - 1));
  const days = new Map<string, MetricsDay>();
  for (let d = from; d <= to; d = addDays(d, 1)) {
    days.set(d, {
      date: d, steps: null, stepGoal: null, distanceMi: null, rhr: null, hrMin: null, hrMax: null, stressAvg: null, bbMax: null, bbMin: null,
      spo2Avg: null, rrAvg: null, caloriesTotal: null, caloriesActive: null, caloriesBmr: null, moderateMin: null, vigorousMin: null,
      weightLb: null, kcalIn: null, proteinG: null, carbsG: null, fatG: null,
    });
  }

  let activities: MetricsActivity[] = [];
  const hrHeat: HeatCell[] = [], stressHeat: HeatCell[] = [];

  const db = openGarmin("garmin.db");
  if (db) {
    try {
      for (const r of db.prepare(`SELECT * FROM daily_summary WHERE DATE(day) >= ? AND DATE(day) <= ?`).all(from, to) as Row[]) {
        const d = days.get(String(r.day).slice(0, 10));
        if (!d) continue;
        Object.assign(d, {
          steps: num(r.steps), stepGoal: num(r.step_goal), distanceMi: r1(num(r.distance)), rhr: num(r.rhr) || null,
          hrMin: num(r.hr_min), hrMax: num(r.hr_max), stressAvg: num(r.stress_avg), bbMax: num(r.bb_max), bbMin: num(r.bb_min),
          spo2Avg: r1(num(r.spo2_avg)), rrAvg: r1(num(r.rr_waking_avg)),
          caloriesTotal: num(r.calories_total), caloriesActive: num(r.calories_active), caloriesBmr: num(r.calories_bmr),
          moderateMin: secs(r.moderate_activity_time) != null ? Math.round(secs(r.moderate_activity_time)! / 60) : null,
          vigorousMin: secs(r.vigorous_activity_time) != null ? Math.round(secs(r.vigorous_activity_time)! / 60) : null,
        });
      }
      for (const r of db.prepare(`SELECT DATE(day) AS d, weight FROM weight WHERE DATE(day) >= ? AND DATE(day) <= ?`).all(from, to) as Row[]) {
        const d = days.get(String(r.d)); if (d) d.weightLb = r1(num(r.weight));
      }
      for (const r of db.prepare(`
        SELECT DATE(timestamp) AS d, CAST(strftime('%H', timestamp) AS INTEGER) AS h, AVG(stress) AS v
        FROM stress WHERE timestamp >= ? AND stress >= 0 GROUP BY d, h`).all(`${from} 00:00:00`) as Row[]) {
        stressHeat.push({ date: String(r.d), hour: Number(r.h), value: Math.round(Number(r.v)) });
      }
    } catch { /* tables missing: leave the gaps */ } finally { db.close(); }
  }

  const mon = openGarmin("garmin_monitoring.db");
  if (mon) {
    try {
      for (const r of mon.prepare(`
        SELECT DATE(timestamp) AS d, CAST(strftime('%H', timestamp) AS INTEGER) AS h, AVG(heart_rate) AS v
        FROM monitoring_hr WHERE timestamp >= ? AND heart_rate > 0 GROUP BY d, h`).all(`${from} 00:00:00`) as Row[]) {
        hrHeat.push({ date: String(r.d), hour: Number(r.h), value: Math.round(Number(r.v)) });
      }
    } catch { /* leave empty */ } finally { mon.close(); }
  }

  const adb = openGarmin("garmin_activities.db");
  if (adb) {
    try {
      activities = (adb.prepare(`${ACTIVITY_SQL}
        WHERE DATE(a.start_time) >= ? AND DATE(a.start_time) <= ? AND (LOWER(a.sport) LIKE '%running%' OR LOWER(a.sport) LIKE '%walking%')
        ORDER BY a.start_time`).all(from, to) as Row[]).map(activityOf);
    } catch { /* leave empty */ } finally { adb.close(); }
  }

  // Food diary (Lose It!) per day.
  try {
    const rows = getDb().prepare(`
      SELECT date, SUM(kcal) AS kcal, SUM(protein_g) AS p, SUM(carbs_g) AS c, SUM(fat_g) AS f
      FROM loseit_food_log WHERE date >= ? AND date <= ? GROUP BY date`).all(from, to) as Row[];
    for (const r of rows) {
      const d = days.get(String(r.date));
      if (d) Object.assign(d, { kcalIn: num(r.kcal) != null ? Math.round(num(r.kcal)!) : null, proteinG: Math.round(Number(r.p) || 0), carbsG: Math.round(Number(r.c) || 0), fatG: Math.round(Number(r.f) || 0) });
    }
  } catch { /* no diary yet */ }

  // Weight: the Nutrition tab's own readings (Garmin Connect weigh-ins, newer than GarminDB's nightly sync).
  let weight: MetricsOverview["weight"] = null;
  try {
    const n = buildNutritionDashboard(numDays);
    for (const w of n.weights) { const d = days.get(w.date); if (d) d.weightLb = r1(w.kg * LB_PER_KG); }
    if (n.current) weight = { kg: n.current.kg, date: n.current.date, avg7Kg: n.current.avg7Kg, postRun: n.current.postRun };
  } catch { /* keep GarminDB's weights */ }

  // Sleep, HRV and resting HR are the Health page's own numbers.
  let health: HealthDay[] = [];
  try { health = (await buildHealthDashboard(numDays)).days; } catch { /* Garmin API unavailable: sleep from GarminDB only is lost */ }

  return { from, to, days: Array.from(days.values()), health, activities, hrHeat, stressHeat, weight };
}

// One day at 5-minute resolution, plus that day's runs and walks.
export function buildMetricsDay(date: string): MetricsDayDetail {
  const points = new Map<string, DayPoint>();
  // "2026-11-19 23:59:00…" → its 5-minute slot, "23:55"
  const key = (ts: string) => `${ts.slice(11, 13)}:${ts.slice(14, 15)}${Number(ts.slice(15, 16)) >= 5 ? "5" : "0"}`;
  const put = (ts: string, k: "hr" | "stress", sum: Map<string, [number, number]>, v: number) => {
    const s = sum.get(`${k}|${key(ts)}`) ?? [0, 0];
    sum.set(`${k}|${key(ts)}`, [s[0] + v, s[1] + 1]);
  };
  const sums = new Map<string, [number, number]>();
  const mon = openGarmin("garmin_monitoring.db");
  if (mon) {
    try {
      for (const r of mon.prepare(`SELECT timestamp, heart_rate FROM monitoring_hr WHERE DATE(timestamp) = ? AND heart_rate > 0`).all(date) as Row[]) {
        put(String(r.timestamp), "hr", sums, Number(r.heart_rate));
      }
    } catch { /* empty */ } finally { mon.close(); }
  }
  const db = openGarmin("garmin.db");
  if (db) {
    try {
      for (const r of db.prepare(`SELECT timestamp, stress FROM stress WHERE DATE(timestamp) = ? AND stress >= 0`).all(date) as Row[]) {
        put(String(r.timestamp), "stress", sums, Number(r.stress));
      }
    } catch { /* empty */ } finally { db.close(); }
  }
  sums.forEach(([total, n], k) => {
    const [kind, t] = k.split("|");
    const p = points.get(t) ?? { t, hr: null, stress: null };
    p[kind as "hr" | "stress"] = Math.round(total / n);
    points.set(t, p);
  });

  let activities: MetricsActivity[] = [];
  const adb = openGarmin("garmin_activities.db");
  if (adb) {
    try {
      activities = (adb.prepare(`${ACTIVITY_SQL} WHERE DATE(a.start_time) = ? ORDER BY a.start_time`).all(date) as Row[]).map(activityOf);
    } catch { /* empty */ } finally { adb.close(); }
  }
  return { date, points: Array.from(points.values()).sort((a, b) => a.t.localeCompare(b.t)), activities };
}
