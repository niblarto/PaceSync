import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readTracksByUris, updateTrackFeatures, regenerateCsvFile } from "@/lib/tracks-store";
import { activeCsvPath, loadRunningPlaylistConfig } from "@/lib/running-playlist-config";

// Settings -> Tracklist -> "missing genres" filter: gives every listed track that has NO genre the genre
// "Unknown". Tracks that already have a genre are left alone, whatever uris are sent.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { uris } = await req.json().catch(() => ({})) as { uris?: string[] };
  if (!Array.isArray(uris) || uris.length === 0 || !uris.every(u => typeof u === "string")) {
    return NextResponse.json({ error: "uris required" }, { status: 400 });
  }

  const csvFile = loadRunningPlaylistConfig().csvFile;
  try {
    let updated = 0;
    for (const row of readTracksByUris(csvFile, uris)) {
      if (!row.uri || (row.genres ?? "").trim() !== "") continue;
      updateTrackFeatures(csvFile, row.uri, { genres: "Unknown" });
      updated++;
    }
    if (updated > 0) await regenerateCsvFile(csvFile, activeCsvPath());
    return NextResponse.json({ ok: true, updated });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to set genre" }, { status: 500 });
  }
}
