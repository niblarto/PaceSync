import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readFile } from "fs/promises";
import { activeCsvPath } from "@/lib/running-playlist-config";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const XLSX = require("xlsx") as typeof import("xlsx");

// Exports every row in the active playlist's CSV missing a Track URI, as an
// .xlsx (name/artist/album columns) — lets the missing tracks be checked
// against another source (a FreeYourMusic workbook, a different export,
// manual lookup) instead of guessing why "Fill URIs from workbook" left
// them unmatched.

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

function isBlank(v: string | undefined): boolean {
  const t = v?.trim().toLowerCase();
  return !t || t === "nan";
}

export async function GET(_req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const csvPath = activeCsvPath();
  const csv = await readFile(csvPath, "utf8");
  const lines = csv.split("\n");
  const headers = parseCsvRow(lines[0].replace(/^﻿/, "")).map(h => h.trim());
  const col = (name: string) => headers.indexOf(name);
  const idxUri = col("Track URI");
  const idxName = col("Track Name");
  const idxArtist = col("Artist Name(s)");
  const idxAlbum = col("Album Name");
  if (idxUri === -1 || idxName === -1) {
    return NextResponse.json({ error: "Library CSV is missing Track URI/Track Name columns" }, { status: 500 });
  }

  const rows: { name: string; artist: string; album: string }[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const row = parseCsvRow(lines[i]);
    if (!isBlank(row[idxUri])) continue;
    rows.push({
      name: row[idxName]?.trim() ?? "",
      artist: idxArtist !== -1 ? (row[idxArtist]?.trim() ?? "") : "",
      album: idxAlbum !== -1 ? (row[idxAlbum]?.trim() ?? "") : "",
    });
  }

  const sheet = XLSX.utils.json_to_sheet(rows, { header: ["name", "artist", "album"] });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Missing URIs");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="missing-uris.xlsx"`,
    },
  });
}
