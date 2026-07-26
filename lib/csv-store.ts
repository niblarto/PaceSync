import { readFile, writeFile } from "fs/promises";

// Single shared reader/writer for the library CSV format used throughout
// this app. Every route that touches a playlist's CSV should go through
// this module instead of hand-rolling its own parser — before this file
// existed, at least four routes duplicated the same quote-aware character-
// loop parser verbatim, with inconsistent \r-stripping and header case-
// sensitivity between them (some matched headers case-sensitively, others
// lower-cased with alias lists), which is exactly the kind of drift that
// causes one route to read a field differently than another wrote it.

// Quote-aware CSV row parser (re-exported from csv-merge.ts, the original
// home of this logic, so existing importers of parseCsvRow don't break).
export { parseCsvRow, csvEscape } from "./csv-merge";
import { parseCsvRow, csvEscape } from "./csv-merge";

export function isBlank(v: string | undefined): boolean {
  const t = v?.trim().toLowerCase();
  return !t || t === "nan";
}

// Loose match key for fuzzy name+artist matching against an external
// workbook export (FreeYourMusic, Chosic, etc.): lowercase, drop
// punctuation, collapse whitespace, strip a parenthetical/dash suffix
// ("Song (Remastered 2011)" -> "song") so minor export differences between
// two sources don't block an otherwise exact match.
export function matchKey(name: string, artist: string): string {
  const clean = (s: string) => s
    .toLowerCase()
    .replace(/\s*[([-].*$/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return `${clean(artist)}|||${clean(name)}`;
}

export interface ParsedCsv {
  /** Raw header cells, in file order, exactly as written (not lower-cased). */
  headers: string[];
  /** Every data row (excludes the header), each already quote-aware split. */
  rows: string[][];
  /** Case-insensitive header lookup: find a column's index by any of several
   *  accepted aliases (e.g. col("Track URI", "Spotify URI", "uri")). -1 if
   *  none of the aliases match. */
  col: (...names: string[]) => number;
}

// Reads and parses a whole CSV file's rows once — every route was
// previously doing this same read+strip+split dance with its own subtly
// different quirks, so this is the one place `\r`/BOM handling and blank-
// line filtering happens. Always strips \r (CRLF line endings silently
// worked before because quote-aware parsing didn't choke on a stray \r in
// the last cell, but leaving it in is never actually wanted) and strips a
// leading BOM from the header.
export async function readCsv(path: string): Promise<ParsedCsv> {
  const text = await readFile(path, "utf8");
  return parseCsv(text);
}

export function parseCsv(text: string): ParsedCsv {
  const lines = text.replace(/\r/g, "").split("\n").filter(l => l.trim().length > 0);
  if (lines.length === 0) {
    return { headers: [], rows: [], col: () => -1 };
  }
  const headers = parseCsvRow(lines[0].replace(/^﻿/, "")).map(h => h.trim());
  const rows = lines.slice(1).map(parseCsvRow);
  const lowerHeaders = headers.map(h => h.toLowerCase());
  const col = (...names: string[]) => {
    const wanted = names.map(n => n.toLowerCase());
    return lowerHeaders.findIndex(h => wanted.includes(h));
  };
  return { headers, rows, col };
}

// Writes rows back out in the given header order, quote-escaping as needed.
// `rows` should already be shaped to match `headers`' column count/order —
// callers building a new row from a name->value map should use `rowFrom`.
export async function writeCsv(path: string, headers: string[], rows: string[][]): Promise<void> {
  const body = [headers, ...rows].map(r => r.map(csvEscape).join(",")).join("\n") + "\n";
  await writeFile(path, body, "utf8");
}

// Builds one row array matching `headers`' order from a partial name->value
// map — any header not present in `byName` becomes a blank cell. Values are
// coerced to strings; `undefined`/`null` become "".
export function rowFrom(headers: string[], byName: Record<string, string | number | undefined | null>): string[] {
  const lowerMap = new Map(Object.entries(byName).map(([k, v]) => [k.toLowerCase(), v]));
  return headers.map(h => {
    const v = lowerMap.get(h.toLowerCase());
    return v == null ? "" : String(v);
  });
}
