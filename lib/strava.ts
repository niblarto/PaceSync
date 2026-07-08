import { loadStravaConfig } from "@/lib/strava-config";
import { loadStravaTokens, saveStravaTokens, type StravaTokens } from "@/lib/strava-tokens";

export type StravaTokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: "not_connected" | "refresh_failed" | "network_error" };

export async function getFreshStravaToken(): Promise<StravaTokenResult> {
  const stored = loadStravaTokens();
  if (!stored) return { ok: false, reason: "not_connected" };

  if (Date.now() < stored.expiresAt * 1000 - 60_000) {
    return { ok: true, token: stored.accessToken };
  }

  const config = loadStravaConfig();
  if (!config) return { ok: false, reason: "not_connected" };

  try {
    const res = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "refresh_token",
        refresh_token: stored.refreshToken,
      }),
    });
    if (!res.ok) return { ok: false, reason: "refresh_failed" };
    const data = await res.json() as { access_token: string; refresh_token: string; expires_at: number };
    const updated: StravaTokens = {
      ...stored,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_at,
    };
    saveStravaTokens(updated);
    return { ok: true, token: updated.accessToken };
  } catch {
    return { ok: false, reason: "network_error" };
  }
}

async function stravaGet<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`https://www.strava.com/api/v3${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Strava API ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export interface StravaActivity {
  id: number;
  name: string;
  sport_type: string;
  start_date_local: string;
  distance: number; // metres
  moving_time: number; // seconds
  elapsed_time: number;
  total_elevation_gain: number;
  average_speed: number; // m/s
  max_speed: number;
  average_heartrate?: number;
  max_heartrate?: number;
  average_cadence?: number;
  kudos_count: number;
  achievement_count: number;
  pr_count: number;
}

export interface StravaAthlete {
  id: number;
  firstname: string;
  lastname: string;
  city: string | null;
  state: string | null;
  country: string | null;
  profile: string | null; // avatar URL
  weight: number | null;
}

export interface StravaZones {
  heart_rate: { custom_zones: boolean; zones: { min: number; max: number }[] };
}

export function getAthlete(token: string) {
  return stravaGet<StravaAthlete>(token, "/athlete");
}

export function getAthleteZones(token: string) {
  return stravaGet<StravaZones>(token, "/athlete/zones");
}

export function listActivities(token: string, perPage = 30, page = 1, opts?: { before?: number; after?: number }) {
  const params = new URLSearchParams({ per_page: String(perPage), page: String(page) });
  if (opts?.before) params.set("before", String(opts.before));
  if (opts?.after) params.set("after", String(opts.after));
  return stravaGet<StravaActivity[]>(token, `/athlete/activities?${params}`);
}
