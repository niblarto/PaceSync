import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readFile, writeFile } from "fs/promises";
import { activeCsvPath } from "@/lib/running-playlist-config";

// Appends accepted song suggestions to public/Running.csv so they join the
// local BPM pool. Spotify playlist addition happens client-side with the
// browser token (same pattern as delete).

interface AddTrack {
  uri: string;
  name: string;
  artist: string;
  tempo: number;
  key: number;
  mode: number;
  energy: number;
  danceability: number;
  valence: number;
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

    const newLines: string[] = [];
    let added = 0;
    for (const t of tracks) {
      if (!t.uri || csv.includes(t.uri)) continue; // skip dupes
      const byName: Record<string, string> = {
        "Track URI": t.uri,
        "Track Name": t.name,
        "Artist Name(s)": t.artist,
        "Tempo": String(t.tempo),
        "Key": String(t.key),
        "Mode": String(t.mode),
        "Energy": String(t.energy),
        "Danceability": String(t.danceability),
        "Valence": String(t.valence),
      };
      newLines.push(headers.map(h => csvEscape(byName[h] ?? "")).join(","));
      added++;
    }

    if (added > 0) {
      const body = csv.endsWith("\n") ? csv : csv + "\n";
      await writeFile(csvPath, body + newLines.join("\n") + "\n", "utf8");
    }
    return NextResponse.json({ ok: true, added });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
