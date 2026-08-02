import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { readTracksByUris } from "@/lib/tracks-store";
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
    const matchedRows = readTracksByUris(csvFile, Array.from(addedAtByUri.keys()));
    if (matchedRows.length === 0) return NextResponse.json({ tracks: [] });

    const tracks: {
      uri: string; name: string; artist: string; tempo: number | null;
      energy: number | null; durationMs: number; addedAt: string;
    }[] = matchedRows.map(row => ({
      uri: row.uri,
      name: row.trackName?.trim() || "Unknown",
      artist: row.artistNames?.trim() || "Unknown",
      tempo: row.tempo ?? null,
      energy: row.energy ?? null,
      durationMs: row.durationMs ?? 0,
      addedAt: addedAtByUri.get(row.uri)!,
    }));
    tracks.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
    return NextResponse.json({ tracks });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
