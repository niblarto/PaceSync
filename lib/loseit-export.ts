import zlib from "zlib";
import { LoseItAuthError } from "@/lib/loseit-gwt";

// Lose It!'s full data export (www.loseit.com/export/data): a ~1.6 MB zip of
// CSVs covering the account's whole history. Only used for the one-off
// history import and the manual "full resync" — day-to-day syncing reads
// single days over RPC (lib/loseit-gwt.ts), which is ~350× smaller.
//
// Known export quirks, all of which the RPC gets right: fractional parts
// lose their leading zeros (5.04 → "5.4", 0.0847 → "0.8"), tiny values show
// as 0.1, calories can carry a thousands separator ("1,488"), and some 2021
// rows label the 4th meal "Drinks" instead of "Snacks".

export interface ExportFoodRow {
  date: string; // YYYY-MM-DD
  meal: number; // 0 Breakfast, 1 Lunch, 2 Dinner, 3 Snacks
  name: string;
  icon: string | null;
  quantity: number | null;
  units: string | null;
  kcal: number | null;
  fatG: number | null;
  satFatG: number | null;
  cholesterolMg: number | null;
  sodiumMg: number | null;
  carbsG: number | null;
  fiberG: number | null;
  sugarG: number | null;
  proteinG: number | null;
}

export async function downloadExport(cookie: string): Promise<Buffer> {
  const res = await fetch("https://www.loseit.com/export/data", {
    headers: { cookie },
    signal: AbortSignal.timeout(120_000),
  });
  if (res.status === 401 || res.status === 403) throw new LoseItAuthError(`export: HTTP ${res.status}`);
  if (!res.ok) throw new Error(`export: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // A logged-out request gets an HTML page back rather than a zip.
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) throw new LoseItAuthError("export: response was not a zip (session expired?)");
  return buf;
}

// Just enough of the zip format to pull one file out: find the end-of-
// central-directory record, walk the central directory for the name, then
// inflate the entry from its local header. No zip64 (the export is small).
export function readZipEntry(zip: Buffer, wanted: string): Buffer | null {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("export: zip directory not found");
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error("export: corrupt zip directory");
    const method = zip.readUInt16LE(p + 10);
    const compSize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    const name = zip.toString("utf8", p + 46, p + 46 + nameLen);
    if (name === wanted) {
      const lNameLen = zip.readUInt16LE(localOffset + 26);
      const lExtraLen = zip.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const data = zip.subarray(start, start + compSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error(`export: unsupported zip compression ${method}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  return rows;
}

const MEALS: Record<string, number> = { breakfast: 0, lunch: 1, dinner: 2, snacks: 3, snack: 3, drinks: 3 };

// "Grams" → "Gram", "Glasses" → "Glass", "Each" stays — the RPC side uses
// singular unit names, so both sources store the same spelling.
export function singularUnit(u: string): string {
  const t = u.trim();
  if (/sses$/i.test(t)) return t.slice(0, -2);
  if (/[^s]s$/i.test(t)) return t.slice(0, -1);
  return t;
}

export function parseFoodLogCsv(text: string): ExportFoodRow[] {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  const header = rows.shift() ?? [];
  const col = (name: string) => {
    const i = header.findIndex(h => h.trim().toLowerCase() === name.toLowerCase());
    if (i < 0) throw new Error(`export: food-logs.csv has no "${name}" column`);
    return i;
  };
  const c = {
    date: col("Date"), name: col("Name"), icon: col("Icon"), meal: col("Meal"), qty: col("Quantity"), units: col("Units"),
    kcal: col("Calories"), deleted: col("Deleted"), fat: col("Fat (g)"), protein: col("Protein (g)"), carbs: col("Carbohydrates (g)"),
    sat: col("Saturated Fat (g)"), sugar: col("Sugars (g)"), fiber: col("Fiber (g)"), chol: col("Cholesterol (mg)"), sodium: col("Sodium (mg)"),
  };
  const num = (s: string | undefined): number | null => {
    if (s === undefined) return null;
    const t = s.replace(/,/g, "").trim();
    if (!t || t.toLowerCase() === "n/a") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  };
  const out: ExportFoodRow[] = [];
  for (const r of rows) {
    if (r.length < header.length) continue;
    if (r[c.deleted]?.trim() === "1") continue;
    const dm = r[c.date].match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!dm) continue;
    const name = r[c.name].trim();
    if (!name) continue;
    out.push({
      date: `${dm[3]}-${dm[1].padStart(2, "0")}-${dm[2].padStart(2, "0")}`,
      meal: MEALS[r[c.meal].trim().toLowerCase()] ?? 3,
      name,
      icon: r[c.icon].trim() || null,
      quantity: num(r[c.qty]),
      units: r[c.units].trim() ? singularUnit(r[c.units]) : null,
      kcal: num(r[c.kcal]),
      fatG: num(r[c.fat]),
      satFatG: num(r[c.sat]),
      cholesterolMg: num(r[c.chol]),
      sodiumMg: num(r[c.sodium]),
      carbsG: num(r[c.carbs]),
      fiberG: num(r[c.fiber]),
      sugarG: num(r[c.sugar]),
      proteinG: num(r[c.protein]),
    });
  }
  return out;
}
