import { getDb } from "@/lib/db";
import type { AiDjMixResponse } from "@/lib/ai-dj-mix";

// A named library of Pace Pro mixes the user has explicitly chosen to keep,
// separate from pace-pro-pin.ts's single "most recent build" slot — that
// pin always gets overwritten by the next build; these are saved on demand
// and stick around until deleted.

export interface SavedPaceProMix {
  id: string;
  title: string;
  totalSec: number;
  timeline: AiDjMixResponse["timeline"];
  splitsCsvText: string;
  fileName: string | null;
  savedAt: string; // ISO timestamp
  /** A GarminDB activity id attached as this mix's route/map, if any. */
  activityId: string | null;
}

interface Row {
  id: string;
  title: string;
  total_sec: number;
  timeline_json: string;
  splits_csv_text: string;
  file_name: string | null;
  saved_at: string;
  activity_id: string | null;
}

function rowToMix(row: Row): SavedPaceProMix {
  return {
    id: row.id,
    title: row.title,
    totalSec: row.total_sec,
    timeline: JSON.parse(row.timeline_json) as AiDjMixResponse["timeline"],
    splitsCsvText: row.splits_csv_text,
    fileName: row.file_name,
    savedAt: row.saved_at,
    activityId: row.activity_id,
  };
}

export function listSavedPaceProMixes(): SavedPaceProMix[] {
  const rows = getDb().prepare("SELECT * FROM saved_pace_pro_mixes ORDER BY saved_at DESC").all() as Row[];
  return rows.map(rowToMix);
}

export function getSavedPaceProMix(id: string): SavedPaceProMix | null {
  const row = getDb().prepare("SELECT * FROM saved_pace_pro_mixes WHERE id = ?").get(id) as Row | undefined;
  return row ? rowToMix(row) : null;
}

function findIdByTitle(title: string): string | null {
  const row = getDb()
    .prepare("SELECT id FROM saved_pace_pro_mixes WHERE lower(trim(title)) = lower(trim(?)) LIMIT 1")
    .get(title) as { id: string } | undefined;
  return row?.id ?? null;
}

export function saveSavedPaceProMix(mix: Omit<SavedPaceProMix, "id" | "savedAt" | "activityId"> & { id?: string }): SavedPaceProMix {
  // No explicit id (a fresh build, not one reopened from the library) —
  // a save/update under a title that already exists in the library
  // overwrites that entry rather than creating a duplicate, so re-saving
  // "RH26 - 8:20" after rebuilding it always replaces the same row instead
  // of piling up near-identical copies under the same name.
  const id = mix.id ?? findIdByTitle(mix.title) ?? `pp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const savedAt = new Date().toISOString();
  // A genuinely new row never carries an activityId of its own — an update
  // (whether by explicit id or a title match against an existing row) must
  // NOT touch whatever activity_id is already on that row, since attach-
  // route and save-mix are separate actions with no reason to clobber each
  // other.
  getDb().prepare(`
    INSERT INTO saved_pace_pro_mixes (id, title, total_sec, timeline_json, splits_csv_text, file_name, saved_at, activity_id)
    VALUES (@id, @title, @totalSec, @timelineJson, @splitsCsvText, @fileName, @savedAt, NULL)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title, total_sec = excluded.total_sec, timeline_json = excluded.timeline_json,
      splits_csv_text = excluded.splits_csv_text, file_name = excluded.file_name, saved_at = excluded.saved_at
  `).run({
    id, title: mix.title, totalSec: mix.totalSec, timelineJson: JSON.stringify(mix.timeline),
    splitsCsvText: mix.splitsCsvText, fileName: mix.fileName, savedAt,
  });
  return getSavedPaceProMix(id)!;
}

export function setSavedPaceProMixActivity(id: string, activityId: string | null): boolean {
  const result = getDb().prepare("UPDATE saved_pace_pro_mixes SET activity_id = ? WHERE id = ?").run(activityId, id);
  return result.changes > 0;
}

export function deleteSavedPaceProMix(id: string): void {
  getDb().prepare("DELETE FROM saved_pace_pro_mixes WHERE id = ?").run(id);
}
