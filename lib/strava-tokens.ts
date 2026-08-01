import { getDb } from "@/lib/db";

// Strava OAuth tokens, stored the same way as spotify_tokens (a kv_config row
// in pacesync.db) — refreshed on demand since there's no NextAuth session
// tying into Strava (auth here is independent of the Spotify sign-in).
const KEY = "strava_tokens";

export interface StravaTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix seconds
  athleteId?: number;
  athleteName?: string;
}

export function saveStravaTokens(tokens: StravaTokens): void {
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(KEY, JSON.stringify(tokens));
}

export function loadStravaTokens(): StravaTokens | null {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(KEY) as { value_json: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.value_json) as StravaTokens;
  } catch {
    return null;
  }
}

export function clearStravaTokens(): void {
  getDb().prepare("DELETE FROM kv_config WHERE key = ?").run(KEY);
}
