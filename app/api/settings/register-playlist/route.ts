import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readFile } from "fs/promises";
import { activeCsvPath, csvPathFor, saveRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { mergeCsvIntoFile, parseCsvRow, csvEscape } from "@/lib/csv-merge";
import { healActiveCsv } from "@/lib/csv-heal";

// Registers a Spotify playlist (already created client-side) as a known
// local playlist with its own CSV, without switching the currently-active
// playlist, then seeds that CSV with the given tracks' rows copied straight
// from the active library (same source-of-truth pattern as
// tracks/copy-to-playlist) — used by "copy to a new playlist" actions (e.g.
// Library Coverage) so the target doesn't need to re-look up BPM/features.

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name, id, uris } = await req.json() as { name?: string; id?: string; uris?: string[] };
  if (!name || !id) return NextResponse.json({ error: "name and id required" }, { status: 400 });
  if (!uris?.length) return NextResponse.json({ error: "No tracks to copy" }, { status: 400 });

  const sourceCsv = await readFile(activeCsvPath(), "utf8").catch(() => "");
  if (!sourceCsv.trim()) return NextResponse.json({ error: "Active playlist has no library CSV" }, { status: 400 });

  const lines = sourceCsv.replace(/\r/g, "").split("\n").filter(l => l.trim());
  const header = parseCsvRow(lines[0].replace(/^﻿/, "")).map(h => h.trim());
  const idxUri = header.findIndex(h => ["track uri", "spotify uri", "spotify id", "uri", "id"].includes(h.toLowerCase()));
  if (idxUri === -1) return NextResponse.json({ error: "Active library has no Track URI column" }, { status: 500 });

  const uriSet = new Set(uris);
  const matchedRows = lines.slice(1)
    .map(l => parseCsvRow(l))
    .filter(row => uriSet.has(row[idxUri]?.trim()));
  if (matchedRows.length === 0) return NextResponse.json({ error: "None of the requested tracks were found in the active library" }, { status: 404 });

  const entry = saveRunningPlaylistConfig({ name, id }, { keepCurrentActive: true });
  const csvBody = [
    header.map(csvEscape).join(","),
    ...matchedRows.map(r => r.map(csvEscape).join(",")),
  ].join("\n") + "\n";
  const result = await mergeCsvIntoFile(csvPathFor(entry), csvBody);
  void healActiveCsv().catch(() => {}); // no-op unless this happens to be the active playlist

  return NextResponse.json({ ok: true, entry, ...result });
}
