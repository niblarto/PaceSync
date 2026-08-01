import { getDb } from "@/lib/db";

const KEY = "garmin_config";

export interface GarminConfig {
  dbPath: string;
}

export function loadGarminConfig(): GarminConfig | null {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(KEY) as { value_json: string } | undefined;
    if (!row) return null;
    const data = JSON.parse(row.value_json) as GarminConfig;
    if (data.dbPath) return data;
  } catch {}
  return null;
}

export function saveGarminConfig(config: GarminConfig): void {
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(KEY, JSON.stringify(config));
}

export function deleteGarminConfig(): void {
  getDb().prepare("DELETE FROM kv_config WHERE key = ?").run(KEY);
}
