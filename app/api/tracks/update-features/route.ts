import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readFile, writeFile } from "fs/promises";
import { activeCsvPath } from "@/lib/running-playlist-config";

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

// Quote-aware CSV row parser (same semantics as the client-side one)
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

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { tracks } = await req.json() as { tracks?: FeatureUpdate[] };
  if (!tracks?.length) return NextResponse.json({ error: "No tracks" }, { status: 400 });

  const byUri = new Map(tracks.map(t => [t.uri, t]));
  const csvPath = activeCsvPath();

  try {
    const csv = await readFile(csvPath, "utf8");
    const lines = csv.split("\n");
    const headers = parseCsvRow(lines[0].replace(/^﻿/, "")).map(h => h.trim());
    const col = (name: string) => headers.indexOf(name);
    const idxUri = col("Track URI");
    const fields: Array<[string, keyof FeatureUpdate]> = [
      ["Tempo", "tempo"], ["Key", "key"], ["Mode", "mode"],
      ["Energy", "energy"], ["Danceability", "danceability"], ["Valence", "valence"],
    ];
    if (idxUri === -1 || col("Tempo") === -1) {
      return NextResponse.json({ error: "CSV missing Track URI/Tempo columns" }, { status: 500 });
    }

    let updated = 0;
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const row = parseCsvRow(lines[i]);
      const t = byUri.get(row[idxUri]?.trim() ?? "");
      if (!t) continue;
      for (const [header, key] of fields) {
        const idx = col(header);
        if (idx !== -1) row[idx] = String(t[key]);
      }
      lines[i] = row.map(csvEscape).join(",");
      updated++;
    }

    if (updated > 0) await writeFile(csvPath, lines.join("\n"), "utf8");
    return NextResponse.json({ ok: true, updated });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
