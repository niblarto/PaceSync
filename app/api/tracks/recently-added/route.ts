import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { activeCsvPath, loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { readCsv } from "@/lib/csv-store";
import { getRecentlyAdded } from "@/lib/added-tracks";

// Tracks added to the active library in the last N days (default 7),
// joined against the current CSV row for display (name/artist/BPM/duration)
// — the added-tracks log only stores uri+timestamp, so a track deleted
// since being added simply won't be found here and is skipped.
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const daysParam = req.nextUrl.searchParams.get("days");
  const days = daysParam ? Math.max(1, parseInt(daysParam, 10) || 7) : 7;

  const csvFile = loadRunningPlaylistConfig().csvFile;
  const recent = getRecentlyAdded(csvFile, days);
  if (recent.length === 0) return NextResponse.json({ tracks: [] });

  const addedAtByUri = new Map(recent.map(r => [r.uri, r.addedAt]));

  try {
    const { rows, col } = await readCsv(activeCsvPath());
    if (rows.length === 0) return NextResponse.json({ tracks: [] });

    const idxUri = col("Track URI", "Spotify URI", "uri");
    const idxName = col("Track Name", "Name");
    const idxArtist = col("Artist Name(s)", "Artist");
    const idxTempo = col("Tempo", "BPM");
    const idxEnergy = col("Energy");
    const idxDuration = col("Duration (ms)", "Duration_ms", "Duration");
    if (idxUri === -1) return NextResponse.json({ tracks: [] });

    const tracks: {
      uri: string; name: string; artist: string; tempo: number | null;
      energy: number | null; durationMs: number; addedAt: string;
    }[] = [];
    for (const row of rows) {
      const uri = row[idxUri]?.trim();
      if (!uri || !addedAtByUri.has(uri)) continue;
      tracks.push({
        uri,
        name: idxName !== -1 ? (row[idxName]?.trim() || "Unknown") : "Unknown",
        artist: idxArtist !== -1 ? (row[idxArtist]?.trim() || "Unknown") : "Unknown",
        tempo: idxTempo !== -1 ? (parseFloat(row[idxTempo]) || null) : null,
        energy: idxEnergy !== -1 ? (parseFloat(row[idxEnergy]) || null) : null,
        durationMs: idxDuration !== -1 ? (parseInt(row[idxDuration], 10) || 0) : 0,
        addedAt: addedAtByUri.get(uri)!,
      });
    }
    tracks.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
    return NextResponse.json({ tracks });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
