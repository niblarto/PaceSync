import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readFile } from "fs/promises";
import { activeCsvPath } from "@/lib/running-playlist-config";
import { getPlayedCounts } from "@/lib/todays-run-history";
import { loadBpmOverrides, RUN_KINDS } from "@/lib/bpm-overrides";

// Reports how much of the library falls within a BPM range the AI DJ mixer
// could actually pick a track for. Each run kind (warmup/work/easy/cooldown
// /rest) has its own configurable max (Settings) — a track outside every
// kind's range can never be selected for any segment. A kind with no
// override configured has no ceiling (any BPM is fair game for it), which
// would make the whole library count as "usable" if any kind were left
// unbounded — in practice all 5 kinds are expected to have a max set.
//
// Sub-95 BPM tracks are bucketed by their doubled ("effective") tempo, same
// convention as the AI DJ mixer and the Sprint BPM summary — a runner reads
// a slow track as double-time, so its usable BPM is the doubled value.
//
// Play counts come from confirmed "Today's Run" history entries and are
// purely historical — a track's measured BPM can drift (a Sync-from-Spotify
// re-enrichment, a corrected ReccoBeats match, etc.) after it was actually
// played, so a track can show plays > 0 while its *current* BPM sits outside
// today's usable range. That's not a bug in the count; it reflects the BPM
// value having changed since the track was picked, not a live filter.

const DOUBLETIME_THRESHOLD = 95;

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

interface BucketTrack { uri: string; name: string; artist: string; played: number }
export interface CoverageBucket {
  bpm: number;       // effective (post-doubling) BPM, in 2-BPM-wide buckets
  count: number;      // tracks whose effective BPM falls in this bucket
  inRange: boolean;   // true if this bucket falls within any kind's usable range
  played: number;     // sum of play counts for tracks in this bucket
  tracks: BucketTrack[];
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const csv = await readFile(activeCsvPath(), "utf8");
    const lines = csv.replace(/\r/g, "").split("\n").filter(l => l.trim());
    if (lines.length < 2) return NextResponse.json({ buckets: [], totalTracks: 0, inRangeTracks: 0, outOfRangeTracks: 0 });

    const headers = parseCsvRow(lines[0].replace(/^﻿/, "")).map(h => h.trim().toLowerCase());
    const idxUri = headers.findIndex(h => ["track uri", "spotify uri", "spotify id", "uri", "id"].includes(h));
    const idxBpm = headers.findIndex(h => ["bpm", "tempo"].includes(h));
    const idxName = headers.findIndex(h => ["track name", "name", "song", "title"].includes(h));
    const idxArtist = headers.findIndex(h => ["artist name(s)", "artist", "artists"].includes(h));
    if (idxUri === -1 || idxBpm === -1) {
      return NextResponse.json({ buckets: [], totalTracks: 0, inRangeTracks: 0, outOfRangeTracks: 0 });
    }

    const overrides = loadBpmOverrides();
    // (min, max) per kind — no override falls back to no bound (0, Infinity),
    // except "work" which has no Settings override at all and gets the
    // assumed 180 ceiling described above.
    const kindBounds = RUN_KINDS.map(kind => {
      const o = overrides[kind];
      const min = typeof o?.min === "number" ? o.min : 0;
      const max = typeof o?.max === "number" ? o.max : Infinity;
      return { min, max };
    });
    const isInAnyKindRange = (bpm: number): boolean =>
      kindBounds.some(b => bpm >= b.min && bpm <= b.max);

    const playedCounts = getPlayedCounts();

    const bucketWidth = 2;
    const bucketTracks = new Map<number, BucketTrack[]>();
    let totalTracks = 0;
    let inRangeTracks = 0;

    for (let i = 1; i < lines.length; i++) {
      const row = parseCsvRow(lines[i]);
      const uri = row[idxUri]?.trim();
      const rawBpm = parseFloat(row[idxBpm]);
      if (!uri?.startsWith("spotify:track:") || isNaN(rawBpm) || rawBpm <= 0) continue;

      totalTracks++;
      const effectiveBpm = rawBpm < DOUBLETIME_THRESHOLD ? rawBpm * 2 : rawBpm;
      const bucket = Math.round(effectiveBpm / bucketWidth) * bucketWidth;
      const list = bucketTracks.get(bucket) ?? [];
      list.push({
        uri,
        name: idxName !== -1 ? (row[idxName]?.trim() || "Unknown") : "Unknown",
        artist: idxArtist !== -1 ? (row[idxArtist]?.trim() || "Unknown") : "Unknown",
        played: playedCounts[uri] ?? 0,
      });
      bucketTracks.set(bucket, list);

      if (isInAnyKindRange(effectiveBpm)) inRangeTracks++;
    }

    const buckets: CoverageBucket[] = Array.from(bucketTracks.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([bpm, tracks]) => ({
        bpm,
        count: tracks.length,
        inRange: isInAnyKindRange(bpm),
        played: tracks.reduce((sum, t) => sum + t.played, 0),
        tracks: tracks.sort((a, b) => b.played - a.played),
      }));

    return NextResponse.json({
      buckets,
      totalTracks,
      inRangeTracks,
      outOfRangeTracks: totalTracks - inRangeTracks,
      kindRanges: RUN_KINDS.map((kind, i) => ({ kind, min: kindBounds[i].min, max: kindBounds[i].max })),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
