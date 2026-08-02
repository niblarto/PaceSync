import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { activeCsvPath, loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { parseCsv, isBlank } from "@/lib/csv-store";
import { readAllTracks, backfillTrackFields, regenerateCsvFile } from "@/lib/tracks-store";
import { healActiveCsv } from "@/lib/csv-heal";

// Fills blank Tempo/Key/Mode/Energy/Danceability/Valence in the library CSV
// from an uploaded Exportify CSV — the "No BPM" playlist round-trip: tracks
// ReccoBeats/Deezer couldn't match get saved to a Spotify playlist, run
// through a BPM-analysis tool, re-exported via Exportify, then imported here
// to backfill the rows healActiveCsv() couldn't complete on its own.

const FEATURE_HEADERS = ["Tempo", "Key", "Mode", "Energy", "Danceability", "Valence"];

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const uploadText = await req.text();
  if (!uploadText.trim()) return NextResponse.json({ error: "Empty file" }, { status: 400 });

  const upload = parseCsv(uploadText);
  if (upload.rows.length === 0) return NextResponse.json({ error: "File has no track rows" }, { status: 400 });

  const uploadUriIdx = upload.col("Track URI");
  if (uploadUriIdx === -1) {
    return NextResponse.json({ error: "Doesn't look like an Exportify CSV — no Track URI column" }, { status: 400 });
  }
  const uploadFeatureIdx = FEATURE_HEADERS.map(h => upload.col(h));
  if (uploadFeatureIdx.every(i => i === -1)) {
    return NextResponse.json({ error: "No BPM/feature columns found in this file" }, { status: 400 });
  }

  // uri -> feature values from the uploaded file
  const byUri = new Map<string, string[]>();
  for (const row of upload.rows) {
    const uri = row[uploadUriIdx]?.trim();
    if (!uri?.startsWith("spotify:track:")) continue;
    byUri.set(uri, row);
  }
  if (byUri.size === 0) {
    return NextResponse.json({ error: "No valid track rows found" }, { status: 400 });
  }

  const csvFile = loadRunningPlaylistConfig().csvFile;
  const rows = readAllTracks(csvFile);

  const FEATURE_KEYS: Array<[string, "tempo" | "key" | "mode" | "energy" | "danceability" | "valence"]> = [
    ["Tempo", "tempo"], ["Key", "key"], ["Mode", "mode"],
    ["Energy", "energy"], ["Danceability", "danceability"], ["Valence", "valence"],
  ];

  let filled = 0;
  let matched = 0;
  for (const row of rows) {
    const uri = row.uri?.trim();
    if (!uri) continue;
    const uploadRow = byUri.get(uri);
    if (!uploadRow) continue;
    matched++;

    const fields: Record<string, string> = {};
    let rowChanged = false;
    FEATURE_KEYS.forEach(([header, key], fi) => {
      const uploadIdx = uploadFeatureIdx[fi];
      if (uploadIdx === -1) return;
      if (!isBlank(String(row[key] ?? ""))) return; // never overwrite existing data
      const value = uploadRow[uploadIdx]?.trim();
      if (isBlank(value)) return;
      fields[key] = value;
      rowChanged = true;
    });
    if (rowChanged) {
      backfillTrackFields(csvFile, uri, fields);
      filled++;
    }
  }

  if (filled > 0) await regenerateCsvFile(csvFile, activeCsvPath());
  // Duration (ms) etc. still missing after the import can go through the
  // usual online-lookup heal sweep.
  const heal = await healActiveCsv().catch(() => null);

  return NextResponse.json({ ok: true, matched, filled, healed: heal?.healed ?? 0 });
}
