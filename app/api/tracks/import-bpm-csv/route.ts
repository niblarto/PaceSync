import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readFile, writeFile } from "fs/promises";
import { activeCsvPath } from "@/lib/running-playlist-config";
import { healActiveCsv } from "@/lib/csv-heal";

// Fills blank Tempo/Key/Mode/Energy/Danceability/Valence in the library CSV
// from an uploaded Exportify CSV — the "No BPM" playlist round-trip: tracks
// ReccoBeats/Deezer couldn't match get saved to a Spotify playlist, run
// through a BPM-analysis tool, re-exported via Exportify, then imported here
// to backfill the rows healActiveCsv() couldn't complete on its own.

const FEATURE_HEADERS = ["Tempo", "Key", "Mode", "Energy", "Danceability", "Valence"];

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

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function isBlank(v: string | undefined): boolean {
  const t = v?.trim().toLowerCase();
  return !t || t === "nan";
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const uploadText = await req.text();
  if (!uploadText.trim()) return NextResponse.json({ error: "Empty file" }, { status: 400 });

  const uploadLines = uploadText.replace(/\r/g, "").split("\n").filter(l => l.trim());
  if (uploadLines.length < 2) return NextResponse.json({ error: "File has no track rows" }, { status: 400 });

  const uploadHeaders = parseCsvRow(uploadLines[0].replace(/^﻿/, "")).map(h => h.trim());
  const uploadUriIdx = uploadHeaders.indexOf("Track URI");
  if (uploadUriIdx === -1) {
    return NextResponse.json({ error: "Doesn't look like an Exportify CSV — no Track URI column" }, { status: 400 });
  }
  const uploadFeatureIdx = FEATURE_HEADERS.map(h => uploadHeaders.indexOf(h));
  if (uploadFeatureIdx.every(i => i === -1)) {
    return NextResponse.json({ error: "No BPM/feature columns found in this file" }, { status: 400 });
  }

  // uri -> feature values from the uploaded file
  const byUri = new Map<string, string[]>();
  for (let i = 1; i < uploadLines.length; i++) {
    const row = parseCsvRow(uploadLines[i]);
    const uri = row[uploadUriIdx]?.trim();
    if (!uri?.startsWith("spotify:track:")) continue;
    byUri.set(uri, row);
  }
  if (byUri.size === 0) {
    return NextResponse.json({ error: "No valid track rows found" }, { status: 400 });
  }

  const csvPath = activeCsvPath();
  const csv = await readFile(csvPath, "utf8");
  const lines = csv.split("\n");
  const headers = parseCsvRow(lines[0].replace(/^﻿/, "")).map(h => h.trim());
  const idxUri = headers.indexOf("Track URI");
  if (idxUri === -1) return NextResponse.json({ error: "Library CSV has no Track URI column" }, { status: 500 });

  let filled = 0;
  let matched = 0;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const row = parseCsvRow(lines[i]);
    const uri = row[idxUri]?.trim();
    if (!uri) continue;
    const uploadRow = byUri.get(uri);
    if (!uploadRow) continue;
    matched++;

    let rowChanged = false;
    FEATURE_HEADERS.forEach((header, fi) => {
      const idx = headers.indexOf(header);
      const uploadIdx = uploadFeatureIdx[fi];
      if (idx === -1 || uploadIdx === -1) return;
      if (!isBlank(row[idx])) return; // never overwrite existing data
      const value = uploadRow[uploadIdx]?.trim();
      if (isBlank(value)) return;
      row[idx] = value;
      rowChanged = true;
    });
    if (rowChanged) {
      lines[i] = row.map(csvEscape).join(",");
      filled++;
    }
  }

  if (filled > 0) await writeFile(csvPath, lines.join("\n"), "utf8");
  // Duration (ms) etc. still missing after the import can go through the
  // usual online-lookup heal sweep.
  const heal = await healActiveCsv().catch(() => null);

  return NextResponse.json({ ok: true, matched, filled, healed: heal?.healed ?? 0 });
}
