import { getDb } from "@/lib/db";

const KEY = "nutrition_config";

// Settings → Nutrition. Weights are always stored in kg; `weightUnit` only
// changes how they're shown.
import type { WeightUnit } from "@/lib/weight-format";
export type { WeightUnit };

export interface NutritionConfig {
  targetWeightKg: number | null;
  goalDate: string | null; // YYYY-MM-DD
  dailyCalorieLimit: number | null; // kcal eaten per day
  minDailyCalories: number; // eating less than this in a day shows red on the calories chart
  weightUnit: WeightUnit;
  trendDays: number; // window the projections are based on
  kcalPerKg: number; // energy in 1 kg of body weight change
}

export const DEFAULT_NUTRITION_CONFIG: NutritionConfig = {
  targetWeightKg: null,
  goalDate: null,
  dailyCalorieLimit: null,
  minDailyCalories: 1400,
  weightUnit: "st",
  trendDays: 28,
  kcalPerKg: 7700,
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
    dailyCalorieLimit: numOrNull(r.dailyCalorieLimit, 500, 10000),
    minDailyCalories: numOrNull(r.minDailyCalories, 0, 5000) ?? d.minDailyCalories,
    weightUnit: r.weightUnit === "kg" || r.weightUnit === "lb" ? r.weightUnit : "st",
    trendDays: Math.round(numOrNull(r.trendDays, 7, 120) ?? d.trendDays),
    kcalPerKg: numOrNull(r.kcalPerKg, 3000, 10000) ?? d.kcalPerKg,
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
