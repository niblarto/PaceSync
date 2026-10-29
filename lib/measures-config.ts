import { getDb } from "@/lib/db";
import { defaultMeasures, sanitizeMeasures, type MeasureSettings } from "@/lib/units";

// Settings → Nutrition → Recipe measures: which US measures are converted to metric, and what one is worth.
const KEY = "recipe_measures";

export function loadMeasures(): MeasureSettings {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(KEY) as { value_json: string } | undefined;
    if (row) return sanitizeMeasures(JSON.parse(row.value_json));
  } catch {}
  return defaultMeasures();
}

export function saveMeasures(m: MeasureSettings): void {
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(KEY, JSON.stringify(m));
}
