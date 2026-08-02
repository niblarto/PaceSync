import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { activeCsvPath, loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { readAllTracks, updateTrackFeatures, regenerateCsvFile } from "@/lib/tracks-store";
import { healActiveCsv } from "@/lib/csv-heal";

// Fills in audio features (Tempo/Key/Mode/Energy/Danceability/Valence) on
// EXISTING Running.csv rows, matched by Track URI. Used after ReccoBeats
// enrichment of tracks that were added without BPM data.

interface FeatureUpdate {
  uri: string;
  tempo: number;
  key: number;
  mode: number;
  energy: number;
  danceability: number;
  valence: number;
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { tracks } = await req.json() as { tracks?: FeatureUpdate[] };
  if (!tracks?.length) return NextResponse.json({ error: "No tracks" }, { status: 400 });

  const byUri = new Map(tracks.map(t => [t.uri, t]));
  const csvFile = loadRunningPlaylistConfig().csvFile;

  try {
    const rows = readAllTracks(csvFile);

    let updated = 0;
    for (const row of rows) {
      const t = byUri.get(row.uri?.trim() ?? "");
      if (!t) continue;
      updateTrackFeatures(csvFile, row.uri, {
        tempo: t.tempo, key: t.key, mode: t.mode,
        energy: t.energy, danceability: t.danceability, valence: t.valence,
      });
      updated++;
    }

    if (updated > 0) {
      await regenerateCsvFile(csvFile, activeCsvPath());
      // Sweep for anything still missing (e.g. Duration) in the background
      void healActiveCsv().catch(e => console.warn("[tracks/update-features] heal failed:", e));
    }
    return NextResponse.json({ ok: true, updated });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
