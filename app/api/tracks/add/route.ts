import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readFile, writeFile } from "fs/promises";
import { activeCsvPath } from "@/lib/running-playlist-config";
import { healActiveCsv } from "@/lib/csv-heal";

// Appends accepted song suggestions to public/Running.csv so they join the
// local BPM pool. Spotify playlist addition happens client-side with the
// browser token (same pattern as delete). After the write, the CSV heal
// sweep backfills anything the caller didn't supply (Duration (ms), audio
// features) so the AI DJ mixer never sees blank rows.

interface AddTrack {
  uri: string;
  name: string;
  artist: string;
  // Optional: a track can be written with no audio-feature match yet (e.g.
  // ReccoBeats/Deezer found nothing) so it still joins the Spotify playlist
  // and the local library — healActiveCsv() backfills these blanks later
  // whenever a lookup does succeed, same as any other incomplete row.
  tempo?: number;
  key?: number;
  mode?: number;
  energy?: number;
  danceability?: number;
  valence?: number;
}

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { tracks } = await req.json() as { tracks?: AddTrack[] };
  if (!tracks?.length) return NextResponse.json({ error: "No tracks" }, { status: 400 });

  const csvPath = activeCsvPath();
  try {
    const csv = await readFile(csvPath, "utf8");
    const lines = csv.split("\n");
    const headers = lines[0].replace(/^﻿/, "").split(",").map(h => h.trim());

    const fresh = tracks.filter(t => t.uri && !csv.includes(t.uri));

    const newLines: string[] = [];
    let added = 0;
    for (const t of fresh) {
      const num = (v: number | undefined) => v == null ? "" : String(v);
      const byName: Record<string, string> = {
        "Track URI": t.uri,
        "Track Name": t.name,
        "Artist Name(s)": t.artist,
        "Tempo": num(t.tempo),
        "Key": num(t.key),
        "Mode": num(t.mode),
        "Energy": num(t.energy),
        "Danceability": num(t.danceability),
        "Valence": num(t.valence),
      };
      newLines.push(headers.map(h => csvEscape(byName[h] ?? "")).join(","));
      added++;
    }

    if (added > 0) {
      const body = csv.endsWith("\n") ? csv : csv + "\n";
      await writeFile(csvPath, body + newLines.join("\n") + "\n", "utf8");
      // Backfill Duration (ms) and any missing features before responding,
      // so a mix built right after the add sees complete rows.
      const heal = await healActiveCsv().catch(() => null);
      return NextResponse.json({ ok: true, added, healed: heal?.healed ?? 0, incomplete: heal?.incomplete ?? 0 });
    }
    return NextResponse.json({ ok: true, added });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
