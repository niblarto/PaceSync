import fs from "fs";
import path from "path";
import { loadGarminConfig } from "@/lib/garmin-config";
import { getNutritionDays } from "@/lib/nutrition";
import { getGarminApiWeights, getGarminWeightSamples, lastGarminWeightFetch } from "@/lib/garmin-weight";
import { cachedTodayBurn } from "@/lib/garmin-connect";
import { loadNutritionConfig, saveNutritionConfig, type NutritionConfig } from "@/lib/nutrition-config";
import { cachedLoseItGoals, getLoseItStatus } from "@/lib/loseit-food";

// Data + projections for the /nutrition page.
//   eaten    — the Lose It! diary PaceSync syncs (lib/loseit-food.ts, via getNutritionDays)
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
  partial: boolean; // today: burnt (and so net) is "so far", from Garmin Connect
}

export interface Projection {
  method: "trend" | "trend7" | "energy" | "plan" | "postrun";
  label: string;
  basis: string; // short explanation of the inputs
  kgPerWeek: number;
  weightAtGoalKg: number | null; // null when there's no goal date
  hitDate: string | null; // when the target is reached at this rate
  hitStatus: "reached" | "on-course" | "never"; // never = wrong direction or > 10 years
  anchorKg: number; // the weight this projection starts from today
  rawKgPerWeek: number; // the measured rate before the 2 lb/week cap
  capped: boolean; // kgPerWeek was limited to the max loss rate
}

export interface NutritionDashboard {
  config: NutritionConfig;
  today: string;
  days: DayRow[]; // chart window, oldest first
  weights: { date: string; kg: number }[]; // longer history for the weight chart (the first weigh-in of each day)
  postRunWeights: { date: string; kg: number }[]; // weigh-ins taken within 3 hours after a run finished
  // The latest reading of any kind (so a post-run weigh-in shows as the current weight),
  // with the 7-day average (regular weigh-ins only) and the latest regular weight.
  current: {
    kg: number; date: string; avg7Kg: number; measuredAt: string | null; source: "Garmin" | "Health Connect";
    postRun: boolean; // the latest reading is a post-run one
    regularKg: number; regularDate: string; // the latest regular weigh-in
  } | null;
  averages: {
    eaten: number | null; burnt: number | null; exercise: number | null; deficit: number | null; net: number | null;
    loggedDays: number; windowDays: number;
    deficit7: number | null; deficit7Days: number; // last 7 complete days
  };
  projections: Projection[];
  required: { kgPerWeek: number; dailyBalance: number; intake: number | null } | null;
  // The straight line fitted through the weigh-ins in the trend window, so
  // the chart can show where the "Scale trend" projection comes from.
  trendFit: { startDate: string; startKg: number; endDate: string; endKg: number } | null;
  // The same over just the last 7 days: a more immediate read than the (configurable) trend window.
  trendFit7: { startDate: string; startKg: number; endDate: string; endKg: number } | null;
  // The same for the post-run weigh-ins (basis of the "Post-run trend" projection).
  postRunFit: { startDate: string; startKg: number; endDate: string; endKg: number } | null;
  // When each data source was last refreshed (ISO timestamps).
  sources: {
    garminWeight: string | null; // weigh-ins from Garmin Connect (hourly + page refresh)
    todayBurn: string | null; // today's calories burnt so far, Garmin Connect
    food: string | null; // last Lose It! diary sync
    garminDb: string | null; // GarminDB sync (activities, past days' burn, sleep)
  };
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

// When each run started and finished (local wall-clock times, as GarminDB stores them).
function garminRuns(since: string): { startMs: number; endMs: number }[] {
  const out: { startMs: number; endMs: number }[] = [];
  const db = openGarmin("garmin_activities.db");
  if (!db) return out;
  try {
    const rows = db.prepare(
      "SELECT start_time AS s, elapsed_time AS e FROM activities WHERE LOWER(sport) LIKE '%run%' AND DATE(start_time) >= ?",
    ).all(since) as { s: string; e: string | null }[];
    for (const r of rows) {
      const startMs = new Date(r.s.slice(0, 19).replace(" ", "T")).getTime();
      const m = (r.e ?? "").match(/^(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (isNaN(startMs) || !m) continue;
      out.push({ startMs, endMs: startMs + (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 });
    }
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

// Least-squares line through the points (y = intercept + slope·x).
function linearFit(points: { x: number; y: number }[], minPoints = 4, minSpanDays = 7): { slope: number; intercept: number } | null {
  if (points.length < minPoints) return null;
  const xs = points.map(p => p.x);
  if (Math.max(...xs) - Math.min(...xs) < minSpanDays) return null;
  const mx = mean(xs)!;
  const my = mean(points.map(p => p.y))!;
  let num = 0, den = 0;
  for (const p of points) { num += (p.x - mx) * (p.y - my); den += (p.x - mx) ** 2; }
  if (!den) return null;
  const slope = num / den;
  return { slope, intercept: my - slope * mx };
}

function project(
  method: Projection["method"], label: string, basis: string, kgPerDay: number,
  anchorKg: number, today: string, config: NutritionConfig,
): Projection {
  // Projections run at the measured rate, however steep: the loss-rate cap only
  // stops a too-aggressive goal date being saved, it doesn't bend the real forecast.
  const rawKgPerDay = kgPerDay;
  const capped = false;
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
  return { method, label, basis, kgPerWeek: kgPerDay * 7, anchorKg, rawKgPerWeek: rawKgPerDay * 7, capped, weightAtGoalKg: atGoal, hitDate, hitStatus };
}

function dataSources(today: string): NutritionDashboard["sources"] {
  let food: string | null = null;
  try { food = getLoseItStatus().lastDaySyncAt; } catch {}
  let garminDb: string | null = null;
  const cfg = loadGarminConfig();
  if (cfg) {
    try { garminDb = fs.statSync(path.join(cfg.dbPath, "garmin.db")).mtime.toISOString(); } catch {}
  }
  const burn = cachedTodayBurn(today);
  let garminWeight: string | null = null;
  try { garminWeight = lastGarminWeightFetch(); } catch {}
  return { garminWeight, todayBurn: burn ? new Date(burn.at).toISOString() : null, food, garminDb };
}

// Weigh-ins closer together than this are the same weigh-in (a re-weigh).
const REWEIGH_MS = 20 * 60_000;
// A weigh-in this soon after a run finishes is a post-run weigh-in.
const POST_RUN_WINDOW_MS = 3 * 3_600_000;

export function buildNutritionDashboard(chartDays: number): NutritionDashboard {
  const config = { ...loadNutritionConfig() };
  // The goal weight and date set in Lose It! (last read, see lib/loseit-food.ts)
  // override the typed ones, and are stored so everything else sees them too.
  const loseItGoals = config.goalFromLoseIt ? cachedLoseItGoals() : null;
  if (loseItGoals) {
    const kg = Math.round((loseItGoals.goalWeightLb / LB_PER_KG) * 1000) / 1000;
    if (kg !== config.targetWeightKg || loseItGoals.goalDate !== config.goalDate) {
      config.targetWeightKg = kg;
      config.goalDate = loseItGoals.goalDate;
      try { saveNutritionConfig({ ...loadNutritionConfig(), targetWeightKg: kg, goalDate: loseItGoals.goalDate }); } catch { /* shown correctly anyway */ }
    }
  }
  const today = ymd(new Date());
  const span = Math.max(chartDays, config.trendDays);
  const since = addDays(today, -(span - 1));
  const weightSince = addDays(today, -(Math.max(WEIGHT_HISTORY_DAYS, span) - 1));

  const nutrition = new Map(getNutritionDays(weightSince, today).map(d => [d.date, d]));
  const daily = garminDaily(since);
  // Today isn't in GarminDB until it's over: use Garmin Connect's burn so far
  // (refreshed by the API routes / coach before this runs).
  let todayPartial = false;
  if (!daily.get(today)?.burnt) {
    const b = cachedTodayBurn(today);
    if (b) { daily.set(today, { burnt: b.total, resting: b.resting, active: b.active }); todayPartial = true; }
  }
  const exercise = garminExercise(since);

  // Weights: Garmin is the source of truth (other apps only copy its scale
  // readings, sometimes onto the wrong day). Garmin Connect (fetched by the
  // page) wins over GarminDB's nightly sync; Health Connect is only used if
  // Garmin has no weigh-ins at all.
  const weightMap = garminWeights(weightSince);
  const apiWeights = getGarminApiWeights(weightSince);
  for (const w of apiWeights) weightMap.set(w.date, w.kg);
  // Individual weigh-ins. A weigh-in taken within POST_RUN_WINDOW_MS after a run
  // finished (from the Garmin activities) is post-run: it reads light (sweat), so
  // it is kept out of the weights, the 7-day average and the Scale trend, and is
  // plotted and projected on its own. Readings within 20 minutes of each other are
  // one weigh-in (a re-weigh; the later reading stands). Of the rest, the first
  // of a day is its weight; later ones are ignored. Where individual readings
  // exist they replace the day's single value from the older sources, which
  // could be a post-run reading.
  const samples = getGarminWeightSamples(weightSince);
  const runs = garminRuns(weightSince);
  const samplesByDay = new Map<string, { at: number; kg: number }[]>();
  for (const s of samples) samplesByDay.set(s.date, [...(samplesByDay.get(s.date) ?? []), { at: Date.parse(s.measuredAt), kg: s.kg }]);
  const postRunMap = new Map<string, number>();
  const regularAt = new Map<string, number>();
  const postRunAt = new Map<string, number>();
  samplesByDay.forEach((list, date) => {
    const sessions: { at: number; kg: number }[] = [];
    for (const r of list) {
      const prev = sessions[sessions.length - 1];
      if (prev && r.at - prev.at <= REWEIGH_MS) sessions[sessions.length - 1] = r;
      else sessions.push(r);
    }
    const afterRun = (at: number) => runs.some(run => run.endMs <= at && at - run.endMs <= POST_RUN_WINDOW_MS);
    const post = sessions.find(x => afterRun(x.at));
    const regular = sessions.find(x => !afterRun(x.at));
    weightMap.delete(date);
    if (regular) { weightMap.set(date, regular.kg); regularAt.set(date, regular.at); }
    if (post) { postRunMap.set(date, post.kg); postRunAt.set(date, post.at); }
  });
  const fromGarmin = weightMap.size > 0;
  if (!fromGarmin) nutrition.forEach((d, date) => { if (d.weightKg != null) weightMap.set(date, d.weightKg); });
  const weights = Array.from(weightMap.entries())
    .map(([date, kg]) => ({ date, kg: Math.round(kg * 1000) / 1000 }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const postRunWeights = Array.from(postRunMap.entries())
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
      partial: date === today && todayPartial,
    });
  }
  const days = allDays.slice(-chartDays);

  // Current weight: latest reading, plus the average of readings in the
  // 7 days up to it (smooths daily water swings; used as the projection start).
  const last = weights[weights.length - 1];
  // The latest reading overall: a post-run one counts if it is newer than the latest
  // regular weigh-in (same day: by time; a later day always wins).
  const lastPost = postRunWeights[postRunWeights.length - 1];
  const postIsLatest = !!lastPost && (!last
    || lastPost.date > last.date
    || (lastPost.date === last.date && (postRunAt.get(lastPost.date) ?? 0) > (regularAt.get(last.date) ?? 0)));
  const current = last || lastPost
    ? {
        kg: postIsLatest ? lastPost.kg : last.kg,
        date: postIsLatest ? lastPost.date : last.date,
        measuredAt: postIsLatest
          ? new Date(postRunAt.get(lastPost.date) ?? Date.now()).toISOString()
          : samples.find(s => s.date === last.date)?.measuredAt ?? apiWeights.find(w => w.date === last.date)?.measuredAt ?? null,
        source: fromGarmin ? "Garmin" as const : "Health Connect" as const,
        avg7Kg: last
          ? Math.round(mean(weights.filter(w => daysBetween(w.date, last.date) < 7).map(w => w.kg))! * 100) / 100
          : lastPost.kg,
        postRun: postIsLatest,
        regularKg: (last ?? lastPost).kg,
        regularDate: (last ?? lastPost).date,
      }
    : null;

  // The goal date follows each weigh-in: the earliest date the target can be
  // reached at the maximum loss rate (Settings → Nutrition can switch this off).
  if (config.goalDateAuto && !loseItGoals && config.targetWeightKg != null && current) {
    const earliest = earliestGoalDate(current.avg7Kg, config.targetWeightKg, today);
    if (earliest !== config.goalDate) {
      config.goalDate = earliest;
      try { saveNutritionConfig({ ...loadNutritionConfig(), goalDate: earliest }); } catch { /* shown correctly anyway */ }
    }
  }

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
  let trendFit: NutritionDashboard["trendFit"] = null;
  let trendFit7: NutritionDashboard["trendFit7"] = null;
  let postRunFit: NutritionDashboard["postRunFit"] = null;
  if (current) {
    const anchor = current.avg7Kg;
    const trendPts = weights
      .filter(w => w.date >= windowStart)
      .map(w => ({ x: daysBetween(windowStart, w.date), y: w.kg }));
    const fit = linearFit(trendPts);
    if (fit) {
      // The scale trend continues from where its own fitted line is today (the
      // same line its rate comes from), so the projection joins it without a jump -
      // like the post-run trend below. The calorie-based projections still start
      // from the steadier 7-day average.
      const r2 = (n: number) => Math.round(n * 1000) / 1000;
      const trendEndKg = fit.intercept + fit.slope * daysBetween(windowStart, today);
      projections.push(project("trend", "Scale trend", `${trendPts.length} weigh-ins over the last ${config.trendDays} days`, fit.slope, trendEndKg, today, config));
      trendFit = {
        startDate: windowStart, startKg: r2(fit.intercept),
        endDate: today, endKg: r2(trendEndKg),
      };
    }
    // The same fit over just the LAST 7 regular weigh-ins (post-run ones aren't in `weights`),
    // however many days they span, so it reacts to what is happening now. Fewer points and a
    // shorter span are enough here than for the long window.
    const last7 = weights.slice(-7);
    const start7 = last7[0]?.date ?? today;
    const pts7 = last7.map(w => ({ x: daysBetween(start7, w.date), y: w.kg }));
    const fit7 = linearFit(pts7, 3, 4);
    if (fit7) {
      const end7Kg = fit7.intercept + fit7.slope * daysBetween(start7, today);
      projections.push(project("trend7", "7-weigh-in trend", `the last ${pts7.length} weigh-ins (not counting post-run ones), ${start7} to ${last7[last7.length - 1].date}`, fit7.slope, end7Kg, today, config));
      const r2b = (n: number) => Math.round(n * 1000) / 1000;
      trendFit7 = { startDate: start7, startKg: r2b(fit7.intercept), endDate: today, endKg: r2b(end7Kg) };
    }
    // The post-run weigh-ins get their own line, starting from where that line is
    // today (they read lower than the morning weight, so not from the 7-day average).
    const postPts = postRunWeights
      .filter(w => w.date >= windowStart)
      .map(w => ({ x: daysBetween(windowStart, w.date), y: w.kg }));
    const postFit = linearFit(postPts, 3);
    if (postFit) {
      const r3 = (n: number) => Math.round(n * 1000) / 1000;
      const startKg = postFit.intercept;
      const endKg = postFit.intercept + postFit.slope * daysBetween(windowStart, today);
      postRunFit = { startDate: windowStart, startKg: r3(startKg), endDate: today, endKg: r3(endKg) };
      projections.push(project("postrun", "Post-run trend", `${postPts.length} post-run weigh-ins over the last ${config.trendDays} days`, postFit.slope, endKg, today, config));
    }
    if (logged.length >= 3) {
      const balance = mean(logged.map(d => d.eaten! - d.burnt!))!;
      projections.push(project(
        "energy", "Calories eaten vs burnt",
        `avg ${Math.round(balance) >= 0 ? "+" : ""}${Math.round(balance)} kcal/day over ${logged.length} logged days`,
        balance / config.kcalPerKg, anchor, today, config,
      ));
    }
    // Sticking to the plan: losing at the maximum rate Lose It! allows
    // (MAX_LOSS_LB_PER_WEEK), from the 7-day average. The calories that takes are
    // shown alongside when the average burn is known.
    {
      const maxKgPerDay = MAX_LOSS_KG_PER_DAY;
      const intake = averages.burnt != null ? Math.round(averages.burnt - maxKgPerDay * config.kcalPerKg) : null;
      projections.push(project(
        "plan", "Sticking to your limit",
        `the maximum ${MAX_LOSS_LB_PER_WEEK} lb a week${intake != null ? ` (about ${intake} kcal/day eaten at avg ${Math.round(averages.burnt!)} burnt)` : ""}`,
        -maxKgPerDay, anchor, today, config,
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

  return { config, today, days, weights, postRunWeights, current, averages, projections, required, trendFit, trendFit7, postRunFit, sources: dataSources(today) };
}
