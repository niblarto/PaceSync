import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readFile } from "fs/promises";
import { activeCsvPath } from "@/lib/running-playlist-config";

// Lightweight parse of the active playlist's CSV for Settings-page features
// (Sprint BPM table + copy-to-playlist) that need track/BPM data without
// pulling in the dashboard's full parseExportifyCsv (album art, duration,
// energy, etc. aren't needed here).

function parseCsvRow(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === "," && !inQuotes) { result.push(current); current = ""; }
    else { current += ch; }
  }
  result.push(current);
  return result;
}

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
    const csv = await readFile(activeCsvPath(), "utf8");
    const lines = csv.replace(/\r/g, "").split("\n").filter(l => l.trim());
    if (lines.length < 2) return NextResponse.json({ tracks: [] });

    const headers = parseCsvRow(lines[0].replace(/^﻿/, "")).map(h => h.trim().toLowerCase());
    const idxUri = headers.findIndex(h => ["track uri", "spotify uri", "spotify id", "uri", "id"].includes(h));
    const idxName = headers.findIndex(h => ["track name", "name", "song", "title"].includes(h));
    const idxArtist = headers.findIndex(h => ["artist name(s)", "artist", "artists"].includes(h));
    const idxBpm = headers.findIndex(h => ["bpm", "tempo"].includes(h));
    if (idxUri === -1) return NextResponse.json({ tracks: [] });

    const tracks: ActiveTrack[] = [];
    for (let i = 1; i < lines.length; i++) {
      const row = parseCsvRow(lines[i]);
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
