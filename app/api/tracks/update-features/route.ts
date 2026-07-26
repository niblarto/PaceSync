import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { activeCsvPath } from "@/lib/running-playlist-config";
import { readCsv, writeCsv } from "@/lib/csv-store";
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
  const csvPath = activeCsvPath();

  try {
    const { headers, rows, col } = await readCsv(csvPath);
    const idxUri = col("Track URI");
    const fields: Array<[string, keyof FeatureUpdate]> = [
      ["Tempo", "tempo"], ["Key", "key"], ["Mode", "mode"],
      ["Energy", "energy"], ["Danceability", "danceability"], ["Valence", "valence"],
    ];
    if (idxUri === -1 || col("Tempo") === -1) {
      return NextResponse.json({ error: "CSV missing Track URI/Tempo columns" }, { status: 500 });
    }

    let updated = 0;
    for (const row of rows) {
      const t = byUri.get(row[idxUri]?.trim() ?? "");
      if (!t) continue;
      for (const [header, key] of fields) {
        const idx = col(header);
        if (idx !== -1) row[idx] = String(t[key]);
      }
      updated++;
    }

    if (updated > 0) {
      await writeCsv(csvPath, headers, rows);
      // Sweep for anything still missing (e.g. Duration) in the background
      void healActiveCsv().catch(e => console.warn("[tracks/update-features] heal failed:", e));
    }
    return NextResponse.json({ ok: true, updated });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
