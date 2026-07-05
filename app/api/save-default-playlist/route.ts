import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readFile, writeFile } from "fs/promises";
import { activeCsvPath } from "@/lib/running-playlist-config";

// Extracts a "Track URI" (or equivalent) column value per data row, used to
// dedup when appending rather than overwriting public/Running.csv.
function extractUris(csv: string): Set<string> {
  const lines = csv.replace(/\r/g, "").split("\n").filter(Boolean);
  const uris = new Set<string>();
  if (lines.length < 2) return uris;
  const headers = lines[0].replace(/^﻿/, "").split(",").map(h => h.trim().toLowerCase());
  const idx = headers.findIndex(h => ["track uri", "spotify uri", "spotify id", "uri", "id"].includes(h));
  if (idx === -1) return uris;
  for (let i = 1; i < lines.length; i++) {
    const cell = lines[i].split(",")[idx]?.trim();
    if (cell) uris.add(cell);
  }
  return uris;
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const mode = req.nextUrl.searchParams.get("mode") === "append" ? "append" : "overwrite";
  const csv = await req.text();
  if (!csv) {
    return NextResponse.json({ error: "No CSV data" }, { status: 400 });
  }

  const dest = activeCsvPath();

  if (mode === "append") {
    let existing = "";
    try { existing = await readFile(dest, "utf8"); } catch { /* no existing file — treat as overwrite */ }
    if (!existing.trim()) {
      await writeFile(dest, csv, "utf8");
      console.log(`[save-default-playlist] no existing file — wrote ${csv.length} bytes to ${dest}`);
      return NextResponse.json({ ok: true });
    }

    const newLines = csv.replace(/\r/g, "").split("\n").filter(Boolean);
    const [, ...newRows] = newLines;
    const existingUris = extractUris(existing);
    const newUris = new Set<string>();
    const header = existing.replace(/\r/g, "").split("\n")[0].replace(/^﻿/, "").split(",").map(h => h.trim().toLowerCase());
    const idx = header.findIndex(h => ["track uri", "spotify uri", "spotify id", "uri", "id"].includes(h));

    const rowsToAppend = newRows.filter(row => {
      if (idx === -1) return true;
      const cell = row.split(",")[idx]?.trim();
      if (!cell) return true;
      if (existingUris.has(cell) || newUris.has(cell)) return false;
      newUris.add(cell);
      return true;
    });

    const body = existing.endsWith("\n") ? existing : existing + "\n";
    await writeFile(dest, body + rowsToAppend.join("\n") + (rowsToAppend.length ? "\n" : ""), "utf8");
    console.log(`[save-default-playlist] appended ${rowsToAppend.length}/${newRows.length} rows to ${dest}`);
    return NextResponse.json({ ok: true, appended: rowsToAppend.length, skipped: newRows.length - rowsToAppend.length });
  }

  await writeFile(dest, csv, "utf8");
  console.log(`[save-default-playlist] wrote ${csv.length} bytes to ${dest}`);
  return NextResponse.json({ ok: true });
}
