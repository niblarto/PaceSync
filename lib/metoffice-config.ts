import { getDb } from "@/lib/db";

// Met Office DataHub credentials + forecast location, configured in Settings.
// Location defaults to the user's home postcode (NG12 4BD) geocoded via
// postcodes.io; stored as lat/lon since that's what the API takes.
const KEY = "metoffice_config";

export interface MetOfficeConfig {
  apiKey: string;
  postcode: string;
  lat: number;
  lon: number;
}

export const DEFAULT_LOCATION = { postcode: "NG12 4BD", lat: 52.914856, lon: -1.111856 };

export function loadMetOfficeConfig(): MetOfficeConfig | null {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(KEY) as { value_json: string } | undefined;
    if (!row) return null;
    const data = JSON.parse(row.value_json) as MetOfficeConfig;
    if (data?.apiKey) return data;
  } catch {}
  return null;
}

export function saveMetOfficeConfig(config: MetOfficeConfig): void {
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(KEY, JSON.stringify(config));
}
