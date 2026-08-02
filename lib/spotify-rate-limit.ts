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

// Soft, pre-emptive burst guard — separate from the hard "blocked until"
// sentinel above, which only ever gets set AFTER Spotify has already
// returned a real 429. That reactive-only design has a real gap: a big
// burst (e.g. one BBC card matching 27 new tracks in ~13s) can leave
// Spotify's actual account-wide quota deeply depleted without ever
// tripping a 429 itself, so the very next unrelated search (e.g. "search
// more by this artist") fires straight through and eats what's left of
// the quota, drawing a much harsher Retry-After as a repeat offender —
// confirmed twice now with the same "Pepper — Butthole Surfers" query.
// This counts recent successful Spotify requests server-side (in-memory,
// per-process — good enough since this app runs single-instance) in a
// short sliding window and imposes a brief cooldown once a burst crosses
// a threshold, independent of whether Spotify has complained yet.
const BURST_WINDOW_MS = 15_000;
const BURST_THRESHOLD = 20; // requests within the window
const BURST_COOLDOWN_MS = 90_000;
let recentRequestTimestamps: number[] = [];
let burstCooldownUntil = 0;

export function recordSpotifyRequest(): void {
  const now = Date.now();
  recentRequestTimestamps.push(now);
  recentRequestTimestamps = recentRequestTimestamps.filter(t => now - t < BURST_WINDOW_MS);
  if (recentRequestTimestamps.length >= BURST_THRESHOLD) {
    burstCooldownUntil = now + BURST_COOLDOWN_MS;
    recentRequestTimestamps = [];
  }
}

// Returns ms remaining in an active burst cooldown, or 0 if none — checked
// before every proxied request so a burst's tail is spaced out rather than
// let the very next request slam into whatever quota Spotify has left.
export function getBurstCooldownRemainingMs(): number {
  return Math.max(0, burstCooldownUntil - Date.now());
}
