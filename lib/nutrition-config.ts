import { getDb } from "@/lib/db";

const KEY = "nutrition_config";

// Settings → Nutrition. Weights are always stored in kg; `weightUnit` only
// changes how they're shown.
import type { WeightUnit } from "@/lib/weight-format";
export type { WeightUnit };

export interface NutritionConfig {
  targetWeightKg: number | null;
  goalDate: string | null; // YYYY-MM-DD
  // true: the goal date is kept at the earliest date reachable at the maximum
  // loss rate, recalculated whenever the nutrition numbers are built (so it
  // follows each weigh-in); false: the date typed in Settings is used.
  goalDateAuto: boolean;
  // true: the target weight and goal date are the ones set in Lose It! (read
  // hourly); they override the two fields above. false: the typed values.
  goalFromLoseIt: boolean;
  dailyCalorieLimit: number | null; // kcal eaten per day
  minDailyCalories: number; // eating less than this in a day shows red on the calories chart
  weightUnit: WeightUnit;
  trendDays: number; // window the projections are based on
  kcalPerKg: number; // energy in 1 kg of body weight change
  proteinPerKg: number; // protein target, g per kg of body weight
  fatPct: number; // fat target, % of the day's calories (carbs take the rest)
}

export const DEFAULT_NUTRITION_CONFIG: NutritionConfig = {
  targetWeightKg: null,
  goalDate: null,
  goalDateAuto: true,
  goalFromLoseIt: true,
  dailyCalorieLimit: null,
  minDailyCalories: 1400,
  weightUnit: "st",
  trendDays: 28,
  kcalPerKg: 7700,
  proteinPerKg: 1.8,
  fatPct: 25,
};

function numOrNull(v: unknown, min: number, max: number): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= min && n <= max ? n : null;
}

export function sanitizeNutritionConfig(raw: unknown): NutritionConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_NUTRITION_CONFIG;
  return {
    targetWeightKg: numOrNull(r.targetWeightKg, 30, 300),
    goalDate: typeof r.goalDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.goalDate) ? r.goalDate : null,
    goalDateAuto: r.goalDateAuto !== false,
    goalFromLoseIt: r.goalFromLoseIt !== false,
    dailyCalorieLimit: numOrNull(r.dailyCalorieLimit, 500, 10000),
    minDailyCalories: numOrNull(r.minDailyCalories, 0, 5000) ?? d.minDailyCalories,
    weightUnit: r.weightUnit === "kg" || r.weightUnit === "lb" ? r.weightUnit : "st",
    trendDays: Math.round(numOrNull(r.trendDays, 7, 120) ?? d.trendDays),
    kcalPerKg: numOrNull(r.kcalPerKg, 3000, 10000) ?? d.kcalPerKg,
    proteinPerKg: numOrNull(r.proteinPerKg, 0.5, 4) ?? d.proteinPerKg,
    fatPct: numOrNull(r.fatPct, 10, 50) ?? d.fatPct,
  };
}

export function loadNutritionConfig(): NutritionConfig {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(KEY) as { value_json: string } | undefined;
    if (row) return sanitizeNutritionConfig(JSON.parse(row.value_json));
  } catch {}
  return { ...DEFAULT_NUTRITION_CONFIG };
}

export function saveNutritionConfig(config: NutritionConfig): void {
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(KEY, JSON.stringify(config));
}
