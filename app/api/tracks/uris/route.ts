import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { readAllTracks } from "@/lib/tracks-store";

// Lightweight URI-only listing of the active playlist's CSV — used to dedupe
// before adding tracks (e.g. from BBC), so the same track never gets added
// twice to either Spotify or the local library.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const uris = new Set(
      readAllTracks(loadRunningPlaylistConfig().csvFile)
        .map(t => t.uri)
        .filter(uri => uri?.startsWith("spotify:track:")),
    );
    return NextResponse.json({ uris: Array.from(uris) });
  } catch {
    return NextResponse.json({ uris: [] });
  }
}
