import { readFile, writeFile } from "fs/promises";
import path from "path";

// App-wide "Spotify is rate limited until X" sentinel, persisted to disk (not
// just an in-memory var) so it survives a redeploy/restart mid-cooldown and
// is shared across every caller — the CSV heal sweep, the dashboard's
// spotifyFetch proxy, anything else that hits api.spotify.com. Without a
// shared, persisted clock, two independent callers each re-request
// immediately after their own 429, each eating a fresh rate limit and
// resetting the effective clear time later every time (this exact bug once
// made csv-heal's retry-at drift later on every re-triggered sweep instead
// of counting down — see its own comment history).
const RATE_LIMIT_PATH = path.join(process.cwd(), "spotify-rate-limit.json");

export async function getSpotifyBlockedUntil(): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(RATE_LIMIT_PATH, "utf8")) as { until?: string };
    if (raw.until && new Date(raw.until).getTime() > Date.now()) return raw.until;
  } catch { /* no file yet, or expired */ }
  return null;
}

export async function setSpotifyBlockedUntil(until: string): Promise<void> {
  try { await writeFile(RATE_LIMIT_PATH, JSON.stringify({ until }), "utf8"); } catch { /* best-effort */ }
}

export function parseRetryAfter(raw: string): number {
  const delta = parseInt(raw, 10);
  if (!isNaN(delta)) return delta;
  const date = new Date(raw).getTime();
  if (!isNaN(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return 30;
}
