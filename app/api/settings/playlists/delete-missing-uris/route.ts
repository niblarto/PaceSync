import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { activeCsvPath, loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { deleteTracksWithNoUri, regenerateCsvFile } from "@/lib/tracks-store";

// Removes every row in the active playlist's CSV that has no Track URI at
// all — these were never matched to Spotify, so there's nothing to
// unfollow/remove there; this is a local-library-only cleanup. Distinct
// from /api/tracks/delete, which matches by URI and so can't target these
// rows in the first place.
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const csvFile = loadRunningPlaylistConfig().csvFile;
  const removed = deleteTracksWithNoUri(csvFile);
  if (removed > 0) await regenerateCsvFile(csvFile, activeCsvPath());

  return NextResponse.json({ ok: true, removed });
}
