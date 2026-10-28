import { getDb } from "@/lib/db";

// Daily nutrition totals from Health Connect (Lose It!), pushed by the
// Android app's NutritionSyncWorker via POST /api/nutrition.

export interface NutritionDay {
  date: string; // YYYY-MM-DD, phone's local day
  energyKcal: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  weightKg: number | null;
  source: string | null;
  updatedAt?: string;
}

interface Row {
  date: string;
  energy_kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  weight_kg: number | null;
  source: string | null;
  updated_at: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(s: unknown): s is string {
  return typeof s === "string" && DATE_RE.test(s);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function normalizeDay(raw: unknown): NutritionDay | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isIsoDate(r.date)) return null;
  return {
    date: r.date,
    energyKcal: num(r.energyKcal),
    proteinG: num(r.proteinG),
    carbsG: num(r.carbsG),
    fatG: num(r.fatG),
    weightKg: num(r.weightKg),
    source: typeof r.source === "string" ? r.source.slice(0, 200) : null,
  };
}

// Replaces every row in [from, to] with `days`. The phone sends the whole
// window it read, so a day whose Lose It! entries were all deleted (and so
// isn't in `days`) gets removed here instead of keeping stale totals.
export function replaceNutritionRange(from: string, to: string, days: NutritionDay[]): number {
  const db = getDb();
  const now = new Date().toISOString();
  const del = db.prepare("DELETE FROM nutrition_daily WHERE date >= ? AND date <= ?");
  const ins = db.prepare(`
    INSERT INTO nutrition_daily (date, energy_kcal, protein_g, carbs_g, fat_g, weight_kg, source, updated_at)
    VALUES (@date, @energyKcal, @proteinG, @carbsG, @fatG, @weightKg, @source, @updatedAt)
    ON CONFLICT(date) DO UPDATE SET
      energy_kcal = excluded.energy_kcal, protein_g = excluded.protein_g,
      carbs_g = excluded.carbs_g, fat_g = excluded.fat_g, weight_kg = excluded.weight_kg,
      source = excluded.source, updated_at = excluded.updated_at
  `);
  const tx = db.transaction(() => {
    del.run(from, to);
    for (const d of days) ins.run({ ...d, updatedAt: now });
  });
  tx();
  return days.length;
}

// Food totals come from the Lose It! diary PaceSync syncs itself
// (loseit_food_log, lib/loseit-food.ts) once that has any data; until then,
// and for weight, from what the phone pushed from Health Connect
// (nutrition_daily — no longer updated now the phone doesn't poll).
export function getNutritionDays(fromDate: string, toDate: string): NutritionDay[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM nutrition_daily WHERE date >= ? AND date <= ? ORDER BY date")
    .all(fromDate, toDate) as Row[];
  const days = new Map<string, NutritionDay>(rows.map(r => [r.date, {
    date: r.date,
    energyKcal: r.energy_kcal,
    proteinG: r.protein_g,
    carbsG: r.carbs_g,
    fatG: r.fat_g,
    weightKg: r.weight_kg,
    source: r.source,
    updatedAt: r.updated_at,
  }]));

  const hasLoseIt = !!db.prepare("SELECT 1 FROM loseit_food_log LIMIT 1").get();
  if (hasLoseIt) {
    const food = db.prepare(`
      SELECT date, SUM(kcal) AS kcal, SUM(protein_g) AS protein, SUM(carbs_g) AS carbs, SUM(fat_g) AS fat, MAX(updated_at) AS at
      FROM loseit_food_log WHERE date >= ? AND date <= ? GROUP BY date
    `).all(fromDate, toDate) as { date: string; kcal: number | null; protein: number | null; carbs: number | null; fat: number | null; at: string }[];
    const byDate = new Map(food.map(f => [f.date, f]));
    // Health Connect food is dropped even on days Lose It! has nothing (the diary is the truth).
    days.forEach(d => { d.energyKcal = null; d.proteinG = null; d.carbsG = null; d.fatG = null; });
    byDate.forEach((f, date) => {
      const round1 = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10);
      const d = days.get(date) ?? { date, energyKcal: null, proteinG: null, carbsG: null, fatG: null, weightKg: null, source: null };
      d.energyKcal = round1(f.kcal);
      d.proteinG = round1(f.protein);
      d.carbsG = round1(f.carbs);
      d.fatG = round1(f.fat);
      d.source = "loseit";
      d.updatedAt = f.at;
      days.set(date, d);
    });
  }
  return Array.from(days.values()).sort((a, b) => a.date.localeCompare(b.date));
}
