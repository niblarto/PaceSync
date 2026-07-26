import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { activeCsvPath } from "@/lib/running-playlist-config";
import { readCsv } from "@/lib/csv-store";

// Lightweight parse of the active playlist's CSV for Settings-page features
// (Sprint BPM table + copy-to-playlist) that need track/BPM data without
// pulling in the dashboard's full parseExportifyCsv (album art, duration,
// energy, etc. aren't needed here).

export interface ActiveTrack {
  uri: string;
  name: string;
  artist: string;
  bpm: number; // 0 = unknown
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { rows, col } = await readCsv(activeCsvPath());
    const idxUri = col("Track URI", "Spotify URI", "Spotify ID", "uri", "id");
    const idxName = col("Track Name", "Name", "Song", "Title");
    const idxArtist = col("Artist Name(s)", "Artist", "Artists");
    const idxBpm = col("BPM", "Tempo");
    if (idxUri === -1) return NextResponse.json({ tracks: [] });

    const tracks: ActiveTrack[] = [];
    for (const row of rows) {
      const uri = row[idxUri]?.trim();
      if (!uri?.startsWith("spotify:track:")) continue;
      const bpm = idxBpm !== -1 ? parseFloat(row[idxBpm]) : NaN;
      tracks.push({
        uri,
        name: row[idxName]?.trim() || "Unknown",
        artist: row[idxArtist]?.trim() || "Unknown",
        bpm: !isNaN(bpm) && bpm > 0 ? Math.round(bpm) : 0,
      });
    }
    return NextResponse.json({ tracks });
  } catch {
    return NextResponse.json({ tracks: [] });
  }
}
