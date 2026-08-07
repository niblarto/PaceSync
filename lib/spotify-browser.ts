import { getSession } from "next-auth/react";

// Client-side Spotify calls must not trust the in-memory useSession() token:
// it goes stale if the tab stays open past the token's 1-hour expiry. Fetching
// the session runs next-auth's server-side JWT callback, which refreshes an
// expired Spotify token before handing it back.
export async function freshSpotifyToken(): Promise<string | null> {
  try {
    const s = await getSession();
    return s?.accessToken ?? null;
  } catch {
    return null;
  }
}

// Global "are we currently rate limited" state, shared across every Spotify
// call site on the dashboard — so a single banner can always show how long
// is left, no matter which action (delete, add, save, search, cleanup...)
// triggered the 429. A plain module-level subscriber list rather than React
// context: this needs to work from plain async functions, not just inside
// component render, and there's only ever one dashboard mounted at a time.
type RateLimitListener = (retryAtMs: number | null) => void;
let retryAtMs: number | null = null;
const listeners = new Set<RateLimitListener>();

function setRetryAt(ms: number | null) {
  retryAtMs = ms;
  listeners.forEach(l => l(ms));
}

export function subscribeSpotifyRateLimit(listener: RateLimitListener): () => void {
  listeners.add(listener);
  listener(retryAtMs);
  return () => { listeners.delete(listener); };
}

// Seeds the banner from the persisted server-side sentinel (GET
// /api/spotify/rate-limit-status) on a fresh page load/refresh — this
// module's own retryAtMs starts null every time, so without this a ban
// that's already active server-side stayed invisible until the next live
// spotifyFetch() call in THIS session happened to hit the same 429 again.
// Only applies a later retryAtMs than whatever's already known, so this
// can never clobber a fresher/longer 429 a live call just recorded.
export function seedSpotifyRateLimitFromServer(ms: number | null): void {
  if (ms != null && (retryAtMs == null || ms > retryAtMs)) setRetryAt(ms);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Auto-retry only kicks in for a short wait — matches the CSV heal sweep's
// own threshold (lib/csv-heal.ts, "wait > 10"), so both halves of the app
// treat the same rate limit the same way. A long Retry-After (Spotify
// commonly hands out 30s+, sometimes minutes, under sustained rate limiting)
// means silently blocking the calling action for that whole span is worse
// than just surfacing the 429 and letting the user retry once the banner's
// countdown reaches zero.
const AUTO_RETRY_MAX_SEC = 10;

// A browser fetch() against api.spotify.com can NEVER read the real
// Retry-After value on a 429 — Spotify doesn't send
// Access-Control-Expose-Headers for it (confirmed via curl: no such header
// in Spotify's CORS response at all), so res.headers.get("Retry-After") is
// always null from client-side JS regardless of what Spotify actually sent.
// Every call therefore goes through /api/spotify/proxy instead, which makes
// the request server-side (no CORS header restriction there) and relays the
// real retryAfterSec back in its JSON body.
//
// Drop-in replacement for fetch() against api.spotify.com: takes the same
// (url, init) shape as a normal call so existing call sites don't need
// restructuring, and returns a real Response-like object. On a 429, always
// publishes the real retry-at timestamp (so any mounted
// <SpotifyRateLimitBanner /> shows a live, accurate countdown to when the
// limit actually clears, however long that is) and never clears it early —
// the banner disappears only once its own countdown reaches zero, not when
// a retry happens to fire. Only actually sleeps-and-retries when the wait is
// <= AUTO_RETRY_MAX_SEC; for anything longer, the 429 is returned as-is so
// the caller's normal error handling (and the banner) tell the user what
// happened, instead of the action hanging for the full wait.
export async function spotifyFetch(url: string, init?: RequestInit): Promise<Response> {
  const path = url.replace(/^https:\/\/api\.spotify\.com/, "");
  const auth = new Headers(init?.headers).get("Authorization") ?? "";
  const method = init?.method ?? "GET";
  const body = init?.body != null ? JSON.parse(String(init.body)) : undefined;

  const maxAttempts = 4; // 1 initial + up to 3 auto-retries, matching the old default
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const proxyRes = await fetch("/api/spotify/proxy", {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ path, method, body }),
    });
    const proxyData = await proxyRes.json() as { status?: number; ok?: boolean; retryAfterSec?: number; data?: unknown; error?: string };

    if (proxyData.error) {
      // The proxy itself failed (network/parse error) — surface as a 502 so
      // callers' !res.ok checks still work.
      return new Response(JSON.stringify({ error: proxyData.error }), { status: 502 });
    }

    if (proxyData.status === 429 && proxyData.retryAfterSec != null) {
      const waitSec = proxyData.retryAfterSec;
      setRetryAt(Date.now() + waitSec * 1000);
      if (waitSec > AUTO_RETRY_MAX_SEC || attempt === maxAttempts - 1) {
        return new Response(JSON.stringify(proxyData.data ?? {}), { status: 429 });
      }
      await sleep(waitSec * 1000);
      continue;
    }

    return new Response(JSON.stringify(proxyData.data ?? {}), { status: proxyData.status ?? 500 });
  }
  // Unreachable (loop always returns), but satisfies TS control-flow analysis.
  return new Response(JSON.stringify({}), { status: 500 });
}
