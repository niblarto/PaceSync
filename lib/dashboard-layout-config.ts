import { getDb } from "@/lib/db";

// Whether the dashboard's left "Heart Rate Zones" column is hidden — a
// display preference toggled from Settings > Integrations (next to AI DJ),
// persisted server-side like the other simple on/off switches in this app.

const KEY = "dashboard_layout";

export function getZonesColumnHidden(): boolean {
  const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(KEY) as { value_json: string } | undefined;
  if (!row) return false;
  try {
    const data = JSON.parse(row.value_json) as { zonesColumnHidden?: boolean };
    return data.zonesColumnHidden ?? false;
  } catch {
    return false;
  }
}

export function setZonesColumnHidden(hidden: boolean): void {
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(KEY, JSON.stringify({ zonesColumnHidden: hidden }));
}
