import fs from "fs";
import path from "path";

// Strava API app credentials — from https://www.strava.com/settings/api.
// Independent of PaceSync's Spotify sign-in; configured in Settings or
// .env.local, stored on the Pi like the other integration configs.
const FILE = path.join(process.cwd(), "strava-config.json");

export interface StravaConfig {
  clientId: string;
  clientSecret: string;
  webhookVerifyToken?: string;   // random string Strava echoes back to prove the subscribe callback is genuine
  webhookSubscriptionId?: number; // Strava's subscription ID, once created
}

export function loadStravaConfig(): StravaConfig | null {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf-8")) as StravaConfig;
    if (data?.clientId && data?.clientSecret) return data;
  } catch {}
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  if (clientId && clientSecret) return { clientId, clientSecret };
  return null;
}

export function saveStravaConfig(config: StravaConfig): void {
  fs.writeFileSync(FILE, JSON.stringify(config), "utf-8");
}

export function updateStravaConfig(patch: Partial<StravaConfig>): StravaConfig {
  const current = loadStravaConfig() ?? { clientId: "", clientSecret: "" };
  const next = { ...current, ...patch };
  saveStravaConfig(next);
  return next;
}
