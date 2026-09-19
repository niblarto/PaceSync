import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { deezerArtistTopTracks } from "@/lib/deezer-artist-top";

// Proxies Deezer artist search + top-tracks for the dashboard's "more by
// this artist" button — see lib/deezer-artist-top.ts for why Deezer/ISRC.

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const artistName = req.nextUrl.searchParams.get("artist");
  if (!artistName) return NextResponse.json({ error: "artist required" }, { status: 400 });
  // includeRelated: also pull top tracks from Deezer's "related artists" for
  // this one — used by the mix track-replace picker (Dashboard's ♻ button),
  // which wants a wider same-vibe pool to BPM-filter from, not just this one
  // artist's own catalog. Off by default (this button wants exactly this
  // artist, nothing else).
  const includeRelated = req.nextUrl.searchParams.get("includeRelated") === "1";

  try {
    const result = await deezerArtistTopTracks(artistName, includeRelated);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 404 });
    return NextResponse.json({ tracks: result.tracks });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Deezer lookup failed" }, { status: 502 });
  }
}
