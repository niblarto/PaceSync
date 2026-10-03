import { readFile, writeFile } from "fs/promises";
import path from "path";

// "Spotify is rate limited until X" sentinel, persisted to disk (not just an
// in-memory var) so it survives a redeploy/restart mid-cooldown — shared
// across every caller that uses the same LANE. Without a shared, persisted
// clock, two independent callers on the same lane each re-request
// immediately after their own 429, each eating a fresh rate limit and
// resetting the effective clear time later every time (this exact bug once
// made csv-heal's retry-at drift later on every re-triggered sweep instead
// of counting down — see its own comment history).
//
// Keyed by lane rather than one global flag: "main" is the user's own OAuth
// session token (playlist add/remove/play — app/api/spotify/proxy, settings
// playlist routes, the BBC cron's playlist writes) and "search" is the two
// query-only client-credentials apps SearchTokenSource rotates between
// (lib/csv-heal.ts's duration/URI passes, the bulk-import confirm route).
// These are different Spotify apps/tokens with independent rate budgets — a
// 429 on the search apps during a heal sweep must NOT block a main-account
// playlist delete, and vice versa (confirmed bug: the old single shared
// sentinel did exactly that, surfacing as a 429 on an unrelated "Delete all
// never-usable tracks" click while only the search lane was actually banned).
export type SpotifyRateLane = "main" | "search";

function rateLimitPath(lane: SpotifyRateLane): string {
  return path.join(process.cwd(), lane === "main" ? "spotify-rate-limit.json" : "spotify-rate-limit-search.json");
}

export async function getSpotifyBlockedUntil(lane: SpotifyRateLane = "main"): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(rateLimitPath(lane), "utf8")) as { until?: string };
    if (raw.until && new Date(raw.until).getTime() > Date.now()) return raw.until;
  } catch { /* no file yet, or expired */ }
  return null;
}

export async function setSpotifyBlockedUntil(until: string, lane: SpotifyRateLane = "main"): Promise<void> {
  try { await writeFile(rateLimitPath(lane), JSON.stringify({ until }), "utf8"); } catch { /* best-effort */ }
}

// Both lanes at once — for a status endpoint/banner that wants to show which
// one(s) are actually blocked, rather than a single merged flag.
export async function getSpotifyBlockedUntilByLane(): Promise<{ main: string | null; search: string | null }> {
  const [main, search] = await Promise.all([getSpotifyBlockedUntil("main"), getSpotifyBlockedUntil("search")]);
  return { main, search };
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

// Two independent Spotify apps can be configured for query-only lookups
// (never playlist writes, which are tied to the user's own OAuth session
// under whichever single app they signed in with — this is strictly a
// client-credentials thing). Spotify's rate limit is per-app, so a second
// app has its own separate 30s rolling budget — used as a fallback wherever
// a query might otherwise need Spotify's Search API (lib/csv-heal.ts's
// duration/URI-search passes, and the "search more by this artist" ISRC-
// miss fallback in app/api/bpm/enrich). SPOTIFY_CLIENT_ID_2/
// SPOTIFY_CLIENT_SECRET_2 are optional — every caller degrades to
// single-app (or no-Spotify-at-all) behavior if they're unset.
async function fetchAppToken(id: string, secret: string): Promise<string | null> {
  try {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) return null;
    return ((await res.json()) as { access_token: string }).access_token;
  } catch {
    return null;
  }
}

export async function spotifyAppToken(): Promise<string | null> {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) return null;
  return fetchAppToken(id, secret);
}

// Second app's token, or null if not configured.
export async function spotifyAppToken2(): Promise<string | null> {
  const id = process.env.SPOTIFY_CLIENT_ID_2;
  const secret = process.env.SPOTIFY_CLIENT_SECRET_2;
  if (!id || !secret) return null;
  return fetchAppToken(id, secret);
}

// Query-only lookups (never a playlist write, which stays on the user's
// own OAuth session under whichever single app they signed in with) prefer
// the SECOND app first when one is configured, so search volume never
// touches the main app's own 30s rolling budget at all — playlist adds/
// plays/deletes (a completely different, user-scoped token) are the only
// thing that should ever draw on that budget. Only falls back to the
// primary app if the second one isn't configured, or itself gets rate-
// limited. Shared by lib/csv-heal.ts's duration/URI-search passes and the
// "search more by this artist" ISRC-miss Spotify-search fallback.
export class SearchTokenSource {
  private primary: string | null | undefined;
  private secondary: string | null | undefined;
  usingPrimary = false;

  constructor(private readonly alreadyBlocked: boolean) {}

  // Returns the token to use right now, or null if nothing usable is
  // available at all (neither app configured, or both rate-limited).
  async current(): Promise<string | null> {
    if (this.usingPrimary) {
      if (this.alreadyBlocked) return null;
      if (this.primary === undefined) this.primary = await spotifyAppToken();
      return this.primary;
    }
    if (this.secondary === undefined) this.secondary = await spotifyAppToken2();
    if (this.secondary) return this.secondary;
    // No second app configured at all — fall back to the primary immediately.
    this.usingPrimary = true;
    if (this.alreadyBlocked) return null;
    if (this.primary === undefined) this.primary = await spotifyAppToken();
    return this.primary;
  }

  // Called after a 429 on whichever token `current()` just returned.
  // Returns true if there's another app left to retry with (caller should
  // retry the same request), false if Spotify is exhausted entirely.
  async onRateLimited(): Promise<boolean> {
    if (!this.usingPrimary) {
      this.usingPrimary = true;
      if (this.alreadyBlocked) return false;
      if (this.primary === undefined) this.primary = await spotifyAppToken();
      return !!this.primary;
    }
    this.primary = null; // primary also rate-limited — nothing left to try
    return false;
  }
}
