import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSpotifyBlockedUntil } from "@/lib/spotify-rate-limit";

// Exposes the persisted "Spotify is rate limited until X" sentinel
// (lib/spotify-rate-limit.ts) to the client — SpotifyRateLimitBanner's own
// in-memory state only ever gets populated reactively, when a live
// spotifyFetch() call in THIS browser session hits a 429, so a fresh page
// load/refresh had no way to show an already-active ban until the next
// Spotify call happened to fail again. Polled once on mount so the banner
// is correct immediately, not just after the user's next action retriggers it.

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const until = await getSpotifyBlockedUntil();
  return NextResponse.json({ until });
}
