import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { readAllTracks } from "@/lib/tracks-store";

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
    const rows = readAllTracks(loadRunningPlaylistConfig().csvFile);

    const tracks: ActiveTrack[] = [];
    for (const row of rows) {
      const uri = row.uri?.trim();
      if (!uri?.startsWith("spotify:track:")) continue;
      const bpm = row.tempo;
      tracks.push({
        uri,
        name: row.trackName?.trim() || "Unknown",
        artist: row.artistNames?.trim() || "Unknown",
        bpm: bpm != null && !isNaN(bpm) && bpm > 0 ? Math.round(bpm) : 0,
      });
    }
    return NextResponse.json({ tracks });
  } catch {
    return NextResponse.json({ tracks: [] });
  }
}
