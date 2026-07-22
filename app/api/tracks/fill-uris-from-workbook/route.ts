import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readFile, writeFile } from "fs/promises";
import { activeCsvPath } from "@/lib/running-playlist-config";
import { healActiveCsv } from "@/lib/csv-heal";

// Fills in Track URI for rows in the active playlist's CSV that have none,
// by matching name+artist against rows extracted client-side from a
// FreeYourMusic/MediaMonkey-style export workbook ({id, name, artist}).
// The workbook is parsed in the browser (xlsx) — this route only ever sees
// plain JSON rows, no file upload handling needed here.

function parseCsvRow(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === "," && !inQuotes) { result.push(current); current = ""; }
    else current += ch;
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

// Loose match key: lowercase, drop punctuation, collapse whitespace, strip
// a parenthetical/dash suffix ("Song (Remastered 2011)" -> "song") so minor
// export differences between the two sources don't block an otherwise
// exact match.
function matchKey(name: string, artist: string): string {
  const clean = (s: string) => s
    .toLowerCase()
    .replace(/\s*[([-].*$/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return `${clean(artist)}|||${clean(name)}`;
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { rows } = await req.json() as { rows?: { id?: string; name?: string; artist?: string }[] };
  if (!rows?.length) return NextResponse.json({ error: "rows required" }, { status: 400 });

  const workbookByKey = new Map<string, string>(); // matchKey -> spotify:track:<id>
  for (const r of rows) {
    if (!r.id || !r.name || !r.artist) continue;
    const key = matchKey(r.name, r.artist);
    if (!workbookByKey.has(key)) workbookByKey.set(key, `spotify:track:${r.id}`);
  }
  if (workbookByKey.size === 0) {
    return NextResponse.json({ error: "No usable id/name/artist rows found in the workbook" }, { status: 400 });
  }

  const csvPath = activeCsvPath();
  const csv = await readFile(csvPath, "utf8");
  const lines = csv.split("\n");
  const headers = parseCsvRow(lines[0].replace(/^﻿/, "")).map(h => h.trim());
  const col = (name: string) => headers.indexOf(name);
  const idxUri = col("Track URI");
  const idxName = col("Track Name");
  const idxArtist = col("Artist Name(s)");
  if (idxUri === -1 || idxName === -1 || idxArtist === -1) {
    return NextResponse.json({ error: "Library CSV is missing Track URI/Track Name/Artist Name(s) columns" }, { status: 500 });
  }

  let matched = 0;
  let checked = 0;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const row = parseCsvRow(lines[i]);
    if (!isBlank(row[idxUri])) continue; // already has a URI — not this route's job
    checked++;
    const name = row[idxName]?.trim() ?? "";
    const artist = row[idxArtist]?.trim() ?? "";
    if (!name || !artist) continue;
    const uri = workbookByKey.get(matchKey(name, artist));
    if (!uri) continue;
    row[idxUri] = uri;
    lines[i] = row.map(csvEscape).join(",");
    matched++;
  }

  if (matched > 0) {
    await writeFile(csvPath, lines.join("\n"), "utf8");
    // Newly-URI'd rows are still missing duration/features/genres — let the
    // usual heal sweep pick them up same as any other freshly-added track.
    void healActiveCsv().catch(() => {});
  }

  return NextResponse.json({ checked, matched, workbookRows: rows.length });
}
