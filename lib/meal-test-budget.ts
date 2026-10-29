import { getDb } from "@/lib/db";

// Settings → Nutrition → "Create meal test budget": a made-up calorie and macro budget for testing "Create meal" at any
// time of day (e.g. in the evening, when nothing is left to eat). While it is on, the Dinner card uses it in place of
// what is really left for the day.
const KEY = "meal_test_budget";

export interface MealTestBudget { enabled: boolean; kcal: number; proteinG: number; carbsG: number; fatG: number }

export const DEFAULT_TEST_BUDGET: MealTestBudget = { enabled: false, kcal: 700, proteinG: 40, carbsG: 60, fatG: 25 };

const num = (v: unknown, min: number, max: number, fallback: number) => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : fallback;
};

export function sanitizeTestBudget(raw: unknown): MealTestBudget {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_TEST_BUDGET;
  return {
    enabled: r.enabled === true,
    kcal: num(r.kcal, 150, 3000, d.kcal),
    proteinG: num(r.proteinG, 0, 300, d.proteinG),
    carbsG: num(r.carbsG, 0, 500, d.carbsG),
    fatG: num(r.fatG, 0, 200, d.fatG),
  };
}

export function loadTestBudget(): MealTestBudget {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(KEY) as { value_json: string } | undefined;
    if (row) return sanitizeTestBudget(JSON.parse(row.value_json));
  } catch {}
  return { ...DEFAULT_TEST_BUDGET };
}

export function saveTestBudget(b: MealTestBudget): void {
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(KEY, JSON.stringify(b));
}
