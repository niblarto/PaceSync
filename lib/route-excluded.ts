import { getDb } from "@/lib/db";

// Activity ids the Route Finder ignores when learning your paths — e.g. races
// on roads that are only closed to traffic on race day.

const KEY = "route_excluded";

export function loadRouteExcluded(): string[] {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(KEY) as { value_json: string } | undefined;
    if (row) {
      const ids = JSON.parse(row.value_json) as unknown;
      if (Array.isArray(ids)) return ids.map(String);
    }
  } catch {}
  return [];
}

export function saveRouteExcluded(ids: string[]): void {
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(KEY, JSON.stringify(ids));
}
