import { readFile, writeFile } from "fs/promises";

// Shared append/merge logic for writing tracks into a library CSV: new URIs
// are appended, URIs already present get any blank existing cell backfilled
// from the incoming row (never overwriting data that's already there).
// Used by save-default-playlist (upload a CSV into the active playlist) and
// tracks/copy-to-playlist (copy tracks from one known playlist into another).

const URI_HEADER_NAMES = ["track uri", "spotify uri", "spotify id", "uri", "id"];

function isBlank(v: string | undefined): boolean {
  const t = v?.trim().toLowerCase();
  return !t || t === "nan";
}

// Quote-aware CSV row parser.
export function parseCsvRow(line: string): string[] {
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

export function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export interface MergeResult {
  appended: number;
  merged: number;
  skipped: number;
}

// Appends `newCsvText` (a full CSV with header) into the file at `dest`,
// merging by Track URI: new URIs are appended as new rows; URIs already
// present get blank cells backfilled from the incoming row. If `dest`
// doesn't exist yet or is empty, the incoming CSV is written as-is.
export async function mergeCsvIntoFile(dest: string, newCsvText: string): Promise<MergeResult> {
  let existing = "";
  try { existing = await readFile(dest, "utf8"); } catch { /* no existing file — treat as a fresh write */ }

  if (!existing.trim()) {
    await writeFile(dest, newCsvText, "utf8");
    return { appended: 0, merged: 0, skipped: 0 };
  }

  const existingLines = existing.replace(/\r/g, "").split("\n").filter(Boolean);
  const existingHeader = parseCsvRow(existingLines[0].replace(/^﻿/, "")).map(h => h.trim());
  const existingUriIdx = existingHeader.findIndex(h => URI_HEADER_NAMES.includes(h.toLowerCase()));

  const newLines = newCsvText.replace(/\r/g, "").split("\n").filter(Boolean);
  const newHeader = parseCsvRow(newLines[0].replace(/^﻿/, "")).map(h => h.trim());
  const newUriIdx = newHeader.findIndex(h => URI_HEADER_NAMES.includes(h.toLowerCase()));
  const newRows = newLines.slice(1).map(l => parseCsvRow(l));

  if (existingUriIdx === -1 || newUriIdx === -1) {
    // No URI column to key on — can't safely dedupe/merge, just append raw.
    const body = existing.endsWith("\n") ? existing : existing + "\n";
    await writeFile(dest, body + newLines.slice(1).join("\n") + (newRows.length ? "\n" : ""), "utf8");
    return { appended: newRows.length, merged: 0, skipped: 0 };
  }

  // Map new-file column names to existing-file column indices, so a merge
  // works even when the two CSVs have different column sets/order.
  const newToExistingCol = newHeader.map(h => existingHeader.findIndex(eh => eh.toLowerCase() === h.toLowerCase()));

  const existingByUri = new Map<string, string[]>();
  const existingRows: string[][] = [];
  for (const line of existingLines.slice(1)) {
    const row = parseCsvRow(line);
    existingRows.push(row);
    const uri = row[existingUriIdx]?.trim();
    if (uri) existingByUri.set(uri, row);
  }

  let appended = 0;
  let merged = 0;
  const newUrisSeen = new Set<string>();
  const rowsToAppend: string[][] = [];

  for (const newRow of newRows) {
    const uri = newRow[newUriIdx]?.trim();
    if (!uri) { rowsToAppend.push(newRow); appended++; continue; }
    if (newUrisSeen.has(uri)) continue; // dupe within the incoming data itself
    newUrisSeen.add(uri);

    const existingRow = existingByUri.get(uri);
    if (!existingRow) {
      rowsToAppend.push(newRow);
      appended++;
      continue;
    }

    // Already present — backfill any blank existing cell from the incoming
    // row's matching column, instead of silently discarding it.
    let rowChanged = false;
    newHeader.forEach((_, newIdx) => {
      const existingIdx = newToExistingCol[newIdx];
      if (existingIdx === -1) return;
      if (!isBlank(existingRow[existingIdx])) return;
      const newVal = newRow[newIdx]?.trim();
      if (isBlank(newVal)) return;
      existingRow[existingIdx] = newVal;
      rowChanged = true;
    });
    if (rowChanged) merged++;
  }

  const rebuiltExisting = existingRows.map(r => r.map(csvEscape).join(","));
  const appendedLines = rowsToAppend.map(r => {
    // A row from a narrower CSV needs padding out to the existing file's
    // column count so the file stays rectangular.
    const padded = existingHeader.map((_, i) => {
      const newIdx = newToExistingCol.indexOf(i);
      return newIdx !== -1 ? (r[newIdx] ?? "") : "";
    });
    return padded.map(csvEscape).join(",");
  });

  const body = [existingHeader.map(csvEscape).join(","), ...rebuiltExisting, ...appendedLines].join("\n") + "\n";
  await writeFile(dest, body, "utf8");
  return { appended, merged, skipped: newRows.length - appended - merged };
}
