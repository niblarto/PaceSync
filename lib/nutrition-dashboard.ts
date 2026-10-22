import path from "path";
import { loadGarminConfig } from "@/lib/garmin-config";
import { getNutritionDays } from "@/lib/nutrition";
import { getGarminApiWeights } from "@/lib/garmin-weight";
import { loadNutritionConfig, type NutritionConfig } from "@/lib/nutrition-config";

// Data + projections for the /nutrition page.
//   eaten    — Lose It! via Health Connect (nutrition_daily)
//   burnt    — Garmin daily total (resting + active)
//   exercise — sum of that day's Garmin activity calories
//   weight   — Health Connect reading, else GarminDB's weight table (lb)

const LB_PER_KG = 2.20462;

// Safe loss rate cap: goal dates needing faster loss can't be saved, and
// projections never assume losing faster than this.
export const MAX_LOSS_LB_PER_WEEK = 2;
const MAX_LOSS_KG_PER_DAY = MAX_LOSS_LB_PER_WEEK / LB_PER_KG / 7;
const WEIGHT_HISTORY_DAYS = 180;

export interface DayRow {
  date: string;
  eaten: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  burnt: number | null;
  resting: number | null;
  exercise: number | null;
  weightKg: number | null;
  deficit: number | null; // burnt − eaten (positive = deficit); null unless both known
  net: number | null; // eaten − burnt (negative = deficit); null unless both known
}

export interface Projection {
  method: "trend" | "energy" | "plan";
  label: string;
  basis: string; // short explanation of the inputs
  kgPerWeek: number;
  weightAtGoalKg: number | null; // null when there's no goal date
  hitDate: string | null; // when the target is reached at this rate
  hitStatus: "reached" | "on-course" | "never"; // never = wrong direction or > 10 years
  rawKgPerWeek: number; // the measured rate before the 2 lb/week cap
  capped: boolean; // kgPerWeek was limited to the max loss rate
}

export interface NutritionDashboard {
  config: NutritionConfig;
  today: string;
  days: DayRow[]; // chart window, oldest first
  weights: { date: string; kg: number }[]; // longer history for the weight chart
  current: { kg: number; date: string; avg7Kg: number; measuredAt: string | null; source: "Garmin" | "Health Connect" } | null;
  averages: {
    eaten: number | null; burnt: number | null; exercise: number | null; deficit: number | null; net: number | null;
    loggedDays: number; windowDays: number;
    deficit7: number | null; deficit7Days: number; // last 7 complete days
  };
  projections: Projection[];
  required: { kgPerWeek: number; dailyBalance: number; intake: number | null } | null;
}

// Earliest date the target can be reached losing at most 2 lb a week.
export function earliestGoalDate(currentKg: number, targetKg: number, today: string): string {
  if (currentKg <= targetKg) return today;
  return addDays(today, Math.ceil((currentKg - targetKg) / MAX_LOSS_KG_PER_DAY));
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${b}T12:00:00`).getTime() - new Date(`${a}T12:00:00`).getTime()) / 86_400_000);
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

function garminDaily(since: string): Map<string, { burnt: number | null; resting: number | null; active: number | null }> {
  const out = new Map<string, { burnt: number | null; resting: number | null; active: number | null }>();
  const db = openGarmin("garmin.db");
  if (!db) return out;
  try {
    const rows = db.prepare(
      "SELECT DATE(day) AS d, calories_total AS t, calories_bmr AS b, calories_active AS a FROM daily_summary WHERE DATE(day) >= ?",
    ).all(since) as { d: string; t: number | null; b: number | null; a: number | null }[];
    for (const r of rows) out.set(r.d, { burnt: r.t || null, resting: r.b || null, active: r.a ?? null });
  } catch {} finally { db.close(); }
  return out;
}

function garminWeights(since: string): Map<string, number> {
  const out = new Map<string, number>();
  const db = openGarmin("garmin.db");
  if (!db) return out;
  try {
    const rows = db.prepare("SELECT DATE(day) AS d, weight AS w FROM weight WHERE DATE(day) >= ? AND weight > 0").all(since) as { d: string; w: number }[];
    for (const r of rows) out.set(r.d, r.w / LB_PER_KG);
  } catch {} finally { db.close(); }
  return out;
}

function garminExercise(since: string): Map<string, number> {
  const out = new Map<string, number>();
  const db = openGarmin("garmin_activities.db");
  if (!db) return out;
  try {
    const rows = db.prepare(
      "SELECT DATE(start_time) AS d, SUM(calories) AS c FROM activities WHERE DATE(start_time) >= ? GROUP BY DATE(start_time)",
    ).all(since) as { d: string; c: number | null }[];
    for (const r of rows) if (r.c) out.set(r.d, r.c);
  } catch {} finally { db.close(); }
  return out;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function linearSlope(points: { x: number; y: number }[]): number | null {
  if (points.length < 4) return null;
  const xs = points.map(p => p.x);
  if (Math.max(...xs) - Math.min(...xs) < 7) return null;
  const mx = mean(xs)!;
  const my = mean(points.map(p => p.y))!;
  let num = 0, den = 0;
  for (const p of points) { num += (p.x - mx) * (p.y - my); den += (p.x - mx) ** 2; }
  return den ? num / den : null;
}

function project(
  method: Projection["method"], label: string, basis: string, kgPerDay: number,
  anchorKg: number, today: string, config: NutritionConfig,
): Projection {
  const rawKgPerDay = kgPerDay;
  const capped = kgPerDay < -MAX_LOSS_KG_PER_DAY;
  if (capped) kgPerDay = -MAX_LOSS_KG_PER_DAY;
  const target = config.targetWeightKg;
  const weightAtGoalKg = config.goalDate ? anchorKg + kgPerDay * Math.max(0, daysBetween(today, config.goalDate)) : null;
  let hitDate: string | null = null;
  let hitStatus: Projection["hitStatus"] = "never";
  if (target != null) {
    const gap = target - anchorKg;
    if (Math.abs(gap) < 0.05) {
      hitStatus = "reached";
      hitDate = today;
    } else if (kgPerDay !== 0 && Math.sign(gap) === Math.sign(kgPerDay)) {
      const days = Math.ceil(gap / kgPerDay);
      if (days <= 3650) { hitStatus = "on-course"; hitDate = addDays(today, days); }
    }
  }
  // Projected weight never goes below the target once it's reached.
  const atGoal = weightAtGoalKg != null && target != null && kgPerDay < 0 && anchorKg > target
    ? Math.max(weightAtGoalKg, target) : weightAtGoalKg;
  return { method, label, basis, kgPerWeek: kgPerDay * 7, rawKgPerWeek: rawKgPerDay * 7, capped, weightAtGoalKg: atGoal, hitDate, hitStatus };
}

export function buildNutritionDashboard(chartDays: number): NutritionDashboard {
  const config = { ...loadNutritionConfig() };
  const today = ymd(new Date());
  const span = Math.max(chartDays, config.trendDays);
  const since = addDays(today, -(span - 1));
  const weightSince = addDays(today, -(Math.max(WEIGHT_HISTORY_DAYS, span) - 1));

  const nutrition = new Map(getNutritionDays(weightSince, today).map(d => [d.date, d]));
  const daily = garminDaily(since);
  const exercise = garminExercise(since);

  // Weights: Garmin is the source of truth (other apps only copy its scale
  // readings, sometimes onto the wrong day). Garmin Connect (fetched by the
  // page) wins over GarminDB's nightly sync; Health Connect is only used if
  // Garmin has no weigh-ins at all.
  const weightMap = garminWeights(weightSince);
  const apiWeights = getGarminApiWeights(weightSince);
  for (const w of apiWeights) weightMap.set(w.date, w.kg);
  const fromGarmin = weightMap.size > 0;
  if (!fromGarmin) nutrition.forEach((d, date) => { if (d.weightKg != null) weightMap.set(date, d.weightKg); });
  const weights = Array.from(weightMap.entries())
    .map(([date, kg]) => ({ date, kg: Math.round(kg * 1000) / 1000 }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const allDays: DayRow[] = [];
  for (let i = span - 1; i >= 0; i--) {
    const date = addDays(today, -i);
    const n = nutrition.get(date);
    const g = daily.get(date);
    const eaten = n?.energyKcal != null ? Math.round(n.energyKcal) : null;
    const burnt = g?.burnt ?? null;
    allDays.push({
      date,
      eaten,
      proteinG: n?.proteinG ?? null,
      carbsG: n?.carbsG ?? null,
      fatG: n?.fatG ?? null,
      burnt,
      resting: g?.resting ?? null,
      exercise: exercise.get(date) != null ? Math.round(exercise.get(date)!) : null,
      weightKg: weightMap.get(date) != null ? Math.round(weightMap.get(date)! * 100) / 100 : null,
      deficit: eaten != null && burnt != null ? burnt - eaten : null,
      net: eaten != null && burnt != null ? eaten - burnt : null,
    });
  }
  const days = allDays.slice(-chartDays);

  // Current weight: latest reading, plus the average of readings in the
  // 7 days up to it (smooths daily water swings; used as the projection start).
  const last = weights[weights.length - 1];
  const current = last
    ? {
        kg: last.kg,
        date: last.date,
        measuredAt: apiWeights.find(w => w.date === last.date)?.measuredAt ?? null,
        source: fromGarmin ? "Garmin" as const : "Health Connect" as const,
        avg7Kg: Math.round(mean(weights.filter(w => daysBetween(w.date, last.date) < 7).map(w => w.kg))! * 100) / 100,
      }
    : null;

  // Averages over the trend window, excluding today (still in progress).
  const windowStart = addDays(today, -config.trendDays);
  const windowDays = allDays.filter(d => d.date >= windowStart && d.date < today);
  const logged = windowDays.filter(d => d.eaten != null && d.burnt != null);
  const last7 = logged.filter(d => d.date >= addDays(today, -7));
  const averages = {
    eaten: mean(logged.map(d => d.eaten!)),
    deficit: mean(logged.map(d => d.deficit!)),
    net: mean(logged.map(d => d.net!)),
    deficit7: mean(last7.map(d => d.deficit!)),
    deficit7Days: last7.length,
    burnt: mean(windowDays.filter(d => d.burnt != null).map(d => d.burnt!)),
    exercise: mean(windowDays.map(d => d.exercise ?? 0)),
    loggedDays: logged.length,
    windowDays: windowDays.length,
  };

  const projections: Projection[] = [];
  let required: NutritionDashboard["required"] = null;
  if (current) {
    const anchor = current.avg7Kg;
    const trendPts = weights
      .filter(w => w.date >= windowStart)
      .map(w => ({ x: daysBetween(windowStart, w.date), y: w.kg }));
    const slope = linearSlope(trendPts);
    if (slope != null) {
      projections.push(project("trend", "Scale trend", `${trendPts.length} weigh-ins over the last ${config.trendDays} days`, slope, anchor, today, config));
    }
    if (logged.length >= 3) {
      const balance = mean(logged.map(d => d.eaten! - d.burnt!))!;
      projections.push(project(
        "energy", "Calories eaten vs burnt",
        `avg ${Math.round(balance) >= 0 ? "+" : ""}${Math.round(balance)} kcal/day over ${logged.length} logged days`,
        balance / config.kcalPerKg, anchor, today, config,
      ));
    }
    // The limit is on calories eaten: balance = limit − average burnt.
    if (config.dailyCalorieLimit != null && averages.burnt != null) {
      const balance = config.dailyCalorieLimit - averages.burnt;
      projections.push(project(
        "plan", "Sticking to your limit",
        `${config.dailyCalorieLimit} kcal/day eaten vs avg ${Math.round(averages.burnt)} burnt`,
        balance / config.kcalPerKg, anchor, today, config,
      ));
    }
    if (config.targetWeightKg != null && config.goalDate && daysBetween(today, config.goalDate) > 0) {
      const kgPerDay = (config.targetWeightKg - anchor) / daysBetween(today, config.goalDate);
      const dailyBalance = kgPerDay * config.kcalPerKg;
      required = {
        kgPerWeek: kgPerDay * 7,
        dailyBalance: Math.round(dailyBalance),
        intake: averages.burnt != null ? Math.round(averages.burnt + dailyBalance) : null,
      };
    }
  }

  return { config, today, days, weights, current, averages, projections, required };
}
