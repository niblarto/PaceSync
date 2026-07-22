import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readFile, writeFile } from "fs/promises";
import { activeCsvPath } from "@/lib/running-playlist-config";
import { parseCsvRow } from "@/lib/csv-merge";

// Removes every row in the active playlist's CSV that has no Track URI at
// all — these were never matched to Spotify, so there's nothing to
// unfollow/remove there; this is a local-library-only cleanup. Distinct
// from /api/tracks/delete, which matches by URI and so can't target these
// rows in the first place.
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const csvPath = activeCsvPath();
  const csv = await readFile(csvPath, "utf8");
  const lines = csv.split("\n");
  const headers = parseCsvRow(lines[0].replace(/^﻿/, "")).map(h => h.trim());
  const idxUri = headers.indexOf("Track URI");
  if (idxUri === -1) return NextResponse.json({ error: "Library CSV is missing a Track URI column" }, { status: 500 });

  const before = lines.length;
  const filtered = lines.filter((line, i) => {
    if (i === 0 || !line.trim()) return true;
    const row = parseCsvRow(line);
    return !!row[idxUri]?.trim();
  });
  const removed = before - filtered.length;
  if (removed > 0) await writeFile(csvPath, filtered.join("\n"), "utf8");

  return NextResponse.json({ ok: true, removed });
}
