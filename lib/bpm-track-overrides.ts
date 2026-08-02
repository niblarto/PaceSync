import { getDb } from "@/lib/db";
import { parseCsv } from "@/lib/csv-store";
import { csvEscape } from "@/lib/csv-merge";

// Permanent per-track BPM correction, keyed by Spotify URI. Wins over the
// CSV's own Tempo column and over any frozen HistoryTrack.tempo snapshot,
// forever, until explicitly cleared — modeled on lib/deleted-tracks.ts's
// "check it everywhere the underlying field is read/merged" pattern.
//
// NOT the same thing as lib/bpm-overrides.ts (bpm_overrides config row),
// which is an unrelated global per-run-kind (warmup/work/easy/etc.) BPM
// ceiling/floor config used by the mixer's selection rules — this store is
// about a single track's own BPM value, not a zone-wide bound.

const NUDGE = 1; // BPM per button press

export interface BpmOverrideEntry {
  value: number;  // the overridden BPM — absolute, not a delta
  setAt: string;  // ISO timestamp of the most recent nudge
}

export type BpmOverrideLog = Record<string, BpmOverrideEntry>; // key: spotify:track:<id>

export function loadBpmTrackOverrides(): BpmOverrideLog {
  const rows = getDb().prepare("SELECT uri, value, set_at FROM bpm_track_overrides").all() as
    { uri: string; value: number; set_at: string }[];
  const log: BpmOverrideLog = {};
  for (const r of rows) log[r.uri] = { value: r.value, setAt: r.set_at };
  return log;
}

export function getBpmOverride(uri: string): BpmOverrideEntry | null {
  const row = getDb().prepare("SELECT value, set_at FROM bpm_track_overrides WHERE uri = ?").get(uri) as
    { value: number; set_at: string } | undefined;
  return row ? { value: row.value, setAt: row.set_at } : null;
}

// Applies a +/-1 BPM nudge. `baseline` is the track's current effective BPM
// (existing override if present, else its CSV/HistoryTrack tempo) — needed
// because the very first nudge on a never-overridden track has to start
// from *some* number, and that number lives outside this store.
//
// Direction is about which BPM/pace pool the track should be drawn from
// next time, not "make the number match how the run felt": "too slow"
// means the run ran slower than the track's cataloged BPM suggests it's
// suited for, so its BPM is corrected DOWN into a slower pool; "too fast"
// corrects it UP into a faster pool.
export function nudgeBpmOverride(uri: string, direction: "slower" | "faster", baseline: number): BpmOverrideEntry {
  const db = getDb();
  const existing = getBpmOverride(uri);
  const current = existing?.value ?? baseline;
  const next = direction === "slower" ? current - NUDGE : current + NUDGE;
  const entry: BpmOverrideEntry = { value: Math.max(1, Math.round(next)), setAt: new Date().toISOString() };
  db.prepare(
    "INSERT INTO bpm_track_overrides (uri, value, set_at) VALUES (?, ?, ?) " +
    "ON CONFLICT(uri) DO UPDATE SET value = excluded.value, set_at = excluded.set_at"
  ).run(uri, entry.value, entry.setAt);
  return entry;
}

export function clearBpmOverride(uri: string): void {
  getDb().prepare("DELETE FROM bpm_track_overrides WHERE uri = ?").run(uri);
}

// Merges overrides onto a set of {uri, tempo} — the one function every
// read-site should call rather than hand-rolling the lookup.
export function applyBpmOverrides<T extends { uri: string | null; tempo: number | null }>(tracks: T[]): T[] {
  const log = loadBpmTrackOverrides();
  return tracks.map(t => (t.uri && log[t.uri] ? { ...t, tempo: log[t.uri].value } : t));
}

// Rewrites the Tempo column of a raw library CSV's text for any row whose
// URI has an active override — used right after reading the CSV for a mix
// build (lib/ai-dj-mix.ts), since the mixer ships the CSV text wholesale to
// a Python service rather than going through a TS-side row->object mapping
// this module could otherwise hook into. A no-op (returns the input
// unchanged) when there are no overrides or no Tempo/Track URI column.
export function applyBpmOverridesToCsvText(csvText: string): string {
  const log = loadBpmTrackOverrides();
  if (Object.keys(log).length === 0) return csvText;

  const { headers, rows, col } = parseCsv(csvText);
  const idxUri = col("Track URI", "Spotify URI", "uri");
  const idxTempo = col("Tempo", "tempo");
  if (idxUri === -1 || idxTempo === -1) return csvText;

  let changed = false;
  for (const row of rows) {
    const uri = row[idxUri]?.trim();
    const override = uri ? log[uri] : undefined;
    if (override) { row[idxTempo] = String(override.value); changed = true; }
  }
  if (!changed) return csvText;

  return [headers, ...rows].map(r => r.map(csvEscape).join(",")).join("\n") + "\n";
}
