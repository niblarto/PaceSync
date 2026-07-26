import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readFile } from "fs/promises";
import { activeCsvPath, loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { parseCsvRow } from "@/lib/csv-merge";
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
    const csv = await readFile(activeCsvPath(), "utf8");
    const lines = csv.replace(/\r/g, "").split("\n").filter(l => l.trim());
    if (lines.length < 2) return NextResponse.json({ tracks: [] });

    const headers = parseCsvRow(lines[0].replace(/^﻿/, "")).map(h => h.trim().toLowerCase());
    const idxUri = headers.findIndex(h => ["track uri", "spotify uri", "uri"].includes(h));
    const idxName = headers.findIndex(h => ["track name", "name"].includes(h));
    const idxArtist = headers.findIndex(h => ["artist name(s)", "artist"].includes(h));
    const idxTempo = headers.findIndex(h => ["tempo", "bpm"].includes(h));
    const idxEnergy = headers.indexOf("energy");
    const idxDuration = headers.findIndex(h => ["duration (ms)", "duration_ms", "duration"].includes(h));
    if (idxUri === -1) return NextResponse.json({ tracks: [] });

    const tracks: {
      uri: string; name: string; artist: string; tempo: number | null;
      energy: number | null; durationMs: number; addedAt: string;
    }[] = [];
    for (let i = 1; i < lines.length; i++) {
      const row = parseCsvRow(lines[i]);
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
