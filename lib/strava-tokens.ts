import fs from "fs";
import path from "path";

// Strava OAuth tokens, stored the same way as spotify-tokens.json — a plain
// file on the Pi (gitignored), refreshed on demand since there's no NextAuth
// session tying into Strava (auth here is independent of the Spotify sign-in).
const FILE = path.join(process.cwd(), "strava-tokens.json");

export interface StravaTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix seconds
  athleteId?: number;
  athleteName?: string;
}

export function saveStravaTokens(tokens: StravaTokens): void {
  fs.writeFileSync(FILE, JSON.stringify(tokens), "utf-8");
}

export function loadStravaTokens(): StravaTokens | null {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf-8")) as StravaTokens;
  } catch {
    return null;
  }
}

export function clearStravaTokens(): void {
  try {
    fs.unlinkSync(FILE);
  } catch { /* already gone */ }
}
