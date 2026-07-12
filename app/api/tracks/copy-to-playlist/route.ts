import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readFile } from "fs/promises";
import { activeCsvPath, csvPathFor, listRunningPlaylists, loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { mergeCsvIntoFile, parseCsvRow } from "@/lib/csv-merge";
import { healActiveCsv } from "@/lib/csv-heal";

// Copies the given track URIs (already in the active playlist's library)
// into another known playlist's local CSV — the local half of the Sprint
// BPM "copy to playlist" feature. Spotify-side add happens client-side with
// the browser token (same pattern as everywhere else); this just keeps the
// target playlist's CSV in step, carrying over whatever data (BPM, energy,
// etc.) the source row already has instead of the target having to
// re-look it up from scratch.

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { targetPlaylistId, uris } = await req.json() as { targetPlaylistId?: string; uris?: string[] };
  if (!targetPlaylistId) return NextResponse.json({ error: "targetPlaylistId required" }, { status: 400 });
  if (!uris?.length) return NextResponse.json({ error: "No tracks to copy" }, { status: 400 });

  const target = listRunningPlaylists().find(p => p.id === targetPlaylistId);
  if (!target) return NextResponse.json({ error: "Unknown target playlist" }, { status: 404 });

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

  const csvBody = [header.join(","), ...matchedRows.map(r => r.join(","))].join("\n") + "\n";
  const dest = csvPathFor(target);
  const result = await mergeCsvIntoFile(dest, csvBody);
  console.log(`[copy-to-playlist] copied into "${target.name}": appended ${result.appended}, merged ${result.merged}`);

  // Copied rows already carry whatever BPM/feature data existed in the
  // active library, so healing usually isn't needed. healActiveCsv() can
  // only ever heal the currently-*active* CSV (no target-path param), so
  // only fire it when the copy destination happens to be that one.
  if (target.id === loadRunningPlaylistConfig().id) {
    void healActiveCsv().catch(() => {});
  }

  return NextResponse.json({ ok: true, ...result });
}
