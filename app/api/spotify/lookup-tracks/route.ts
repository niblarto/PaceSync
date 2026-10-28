import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { getLookupToken } from "@/lib/spotify-lookup-account";
import { getSpotifyBlockedUntil, setSpotifyBlockedUntil, parseRetryAfter, recordSpotifyRequest } from "@/lib/spotify-rate-limit";

// Looks up up to 50 tracks by id (one request each, spaced) on the SECONDARY lookup account (never the main account), so
// checking that tracks still exist doesn't use the main account's allowance.
//   POST { ids: string[] } -> { tracks: (object | null)[] }   (null = Spotify reports it gone)
// A rate limit (the "search" lane's own marker) returns 429 with retryAfterSec instead of retrying.
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { ids } = await req.json().catch(() => ({})) as { ids?: string[] };
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 50 || !ids.every(i => /^[A-Za-z0-9]{22}$/.test(i))) {
    return NextResponse.json({ error: "ids: 1-50 Spotify track ids required" }, { status: 400 });
  }
  const blocked = await getSpotifyBlockedUntil("search");
  if (blocked) return NextResponse.json({ error: "Spotify lookups are rate-limited", retryAfterSec: Math.ceil((new Date(blocked).getTime() - Date.now()) / 1000) }, { status: 429 });

  const token = await getLookupToken();
  if (!token.ok) return NextResponse.json({ error: token.reason }, { status: 503 });

  // One request per track, spaced out: Spotify refuses the several-tracks-in-one-request endpoint for this
  // (newer) app with a 403, and single lookups are allowed. 404 = the track is gone (null).
  const tracks: (unknown | null)[] = [];
  for (let i = 0; i < ids.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 500)); // a gap between requests, never a burst
    recordSpotifyRequest();
    const res = await fetch(`https://api.spotify.com/v1/tracks/${ids[i]}`, { headers: { Authorization: `Bearer ${token.token}` } }).catch(() => null);
    if (!res) return NextResponse.json({ error: "Couldn't reach Spotify" }, { status: 502 });
    if (res.status === 429) {
      const wait = Math.min(parseRetryAfter(res.headers.get("Retry-After") ?? "30"), 24 * 3600);
      await setSpotifyBlockedUntil(new Date(Date.now() + wait * 1000 + 30_000).toISOString(), "search");
      return NextResponse.json({ error: "Spotify lookups are rate-limited", retryAfterSec: wait }, { status: 429 });
    }
    if (res.status === 404) { tracks.push(null); continue; }
    if (!res.ok) return NextResponse.json({ error: `Spotify ${res.status}` }, { status: 502 });
    tracks.push(await res.json());
  }
  return NextResponse.json({ tracks });
}
