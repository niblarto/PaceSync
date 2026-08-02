import { NextRequest, NextResponse } from "next/server";
import { getSpotifyBlockedUntil, setSpotifyBlockedUntil, parseRetryAfter, recordSpotifyRequest, getBurstCooldownRemainingMs } from "@/lib/spotify-rate-limit";

// Relays a single Spotify Web API request server-side and hands the response
// back as JSON, including the real Retry-After value on a 429 — something a
// browser fetch() against api.spotify.com can NEVER read directly, since
// Spotify doesn't send Access-Control-Expose-Headers: Retry-After (or any
// other custom header) on its CORS response. Without this, the dashboard's
// rate-limit countdown was always a guessed fallback, never Spotify's actual
// wait time.
//
// Shares the same persisted "blocked until" sentinel as the CSV heal sweep
// (lib/spotify-rate-limit.ts) — a rate limit hit by the background heal
// process is honored here too (skips straight to reporting it, rather than
// burning another request just to get the same 429 again), and vice versa.
//
// The client already holds its own fresh access token (freshSpotifyToken())
// and sends it as this request's own Authorization header — the proxy just
// forwards that straight through to Spotify rather than re-deriving a
// session server-side, since it's a generic relay for any spotify.com path.

export async function POST(req: NextRequest) {
  const auth = req.headers.get("Authorization");
  if (!auth) return NextResponse.json({ error: "Missing Authorization" }, { status: 401 });

  const { path, method, body } = await req.json() as { path?: string; method?: string; body?: unknown };
  if (!path || !path.startsWith("/")) {
    return NextResponse.json({ error: "path required, must start with /" }, { status: 400 });
  }

  const blockedUntil = await getSpotifyBlockedUntil();
  if (blockedUntil) {
    const retryAfterSec = Math.max(0, Math.ceil((new Date(blockedUntil).getTime() - Date.now()) / 1000));
    return NextResponse.json({ status: 429, ok: false, retryAfterSec, data: null });
  }

  // Pre-emptive soft guard: a recent burst (e.g. a big BBC card match) may
  // have deeply depleted Spotify's real quota without ever drawing a 429
  // itself — firing straight through right after one risks the next
  // request eating what's left and drawing a much harsher ban as a repeat
  // offender. Space this out instead of letting it through immediately.
  const burstWaitMs = getBurstCooldownRemainingMs();
  if (burstWaitMs > 0) {
    return NextResponse.json({ status: 429, ok: false, retryAfterSec: Math.ceil(burstWaitMs / 1000), data: null });
  }

  try {
    recordSpotifyRequest();
    const res = await fetch(`https://api.spotify.com${path}`, {
      method: method ?? "GET",
      headers: {
        Authorization: auth,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    let retryAfterSec: number | undefined;
    if (res.status === 429) {
      retryAfterSec = parseRetryAfter(res.headers.get("Retry-After") ?? "30");
      console.warn(`[spotify/proxy] 429 on ${method ?? "GET"} ${path} — retry-after ${retryAfterSec}s`);
      await setSpotifyBlockedUntil(new Date(Date.now() + retryAfterSec * 1000).toISOString());
    }

    // Spotify's responses are JSON except for a 204 (empty body) on some
    // writes (e.g. playlist item removal) — guard against parsing empty text.
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }

    return NextResponse.json({ status: res.status, ok: res.ok, retryAfterSec, data });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Proxy request failed" }, { status: 502 });
  }
}
