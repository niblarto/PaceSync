import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getCsvStatus } from "@/lib/csv-heal";
import { getSpotifyBlockedUntil } from "@/lib/spotify-rate-limit";

// Read-only column-blank snapshot for the active playlist's CSV — same
// data /api/settings/heal-now returns inline when the sweep is triggered,
// but fetchable independently so the Settings page can show it on mount
// (surviving a reload) and refresh it once a running sweep finishes.
//
// spotifyBlockedUntil is the SEARCH-lane shared sentinel (lib/spotify-rate-
// limit.ts) — the heal sweep only ever does lookups (URI search, duration,
// features), never a playlist write, so it always runs on the query-only
// app-credential lane, not the user's own OAuth session. Not a heal-sweep-
// local field: a sweep that never itself hit a 429 (e.g. it skipped Spotify
// entirely because the sentinel was already blocking it) has nothing of its
// own to report, so the cooldown must be read from here to show up reliably
// regardless of what the last sweep did.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const status = await getCsvStatus().catch(() => null);
  const spotifyBlockedUntil = await getSpotifyBlockedUntil("search").catch(() => null);
  return NextResponse.json({ status, spotifyBlockedUntil });
}
