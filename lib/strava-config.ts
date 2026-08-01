import { getDb } from "@/lib/db";

// Strava API app credentials — from https://www.strava.com/settings/api.
// Independent of PaceSync's Spotify sign-in; configured in Settings or
// .env.local, stored in the app's DB like the other integration configs.
const KEY = "strava_config";

export interface StravaConfig {
  clientId: string;
  clientSecret: string;
  webhookVerifyToken?: string;   // random string Strava echoes back to prove the subscribe callback is genuine
  webhookSubscriptionId?: number; // Strava's subscription ID, once created
}

export function loadStravaConfig(): StravaConfig | null {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(KEY) as { value_json: string } | undefined;
    if (row) {
      const data = JSON.parse(row.value_json) as StravaConfig;
      if (data?.clientId && data?.clientSecret) return data;
    }
  } catch {}
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  if (clientId && clientSecret) return { clientId, clientSecret };
  return null;
}

export function saveStravaConfig(config: StravaConfig): void {
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(KEY, JSON.stringify(config));
}

export function updateStravaConfig(patch: Partial<StravaConfig>): StravaConfig {
  const current = loadStravaConfig() ?? { clientId: "", clientSecret: "" };
  const next = { ...current, ...patch };
  saveStravaConfig(next);
  return next;
}
