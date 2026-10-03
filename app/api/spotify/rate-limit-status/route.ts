import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSpotifyBlockedUntilByLane } from "@/lib/spotify-rate-limit";

// Exposes the persisted "Spotify is rate limited until X" sentinels
// (lib/spotify-rate-limit.ts) to the client — SpotifyRateLimitBanner's own
// in-memory state only ever gets populated reactively, when a live
// spotifyFetch() call in THIS browser session hits a 429, so a fresh page
// load/refresh had no way to show an already-active ban until the next
// Spotify call happened to fail again. Polled once on mount so the banner
// is correct immediately, not just after the user's next action retriggers it.
//
// Both lanes are returned (not just "main") so the banner can say which
// account is actually affected — the main OAuth account (playlist add/
// remove/play) and the query-only search apps (heal sweep, BBC matching,
// bulk import) have independent rate budgets and are blocked independently.

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { main, search } = await getSpotifyBlockedUntilByLane();
  return NextResponse.json({ main, search });
}
