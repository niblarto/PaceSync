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
  /** The Spotify playlist this mix's tracks were last saved to (find-or-
      create by the mix's OWN title, not the shared "Today's Run" playlist)
      — set the first time "Save to Spotify" runs for this saved mix, so a
      later rename can PUT the new name onto this exact playlist instead of
      re-searching by (soon-to-be-stale) name. null until that first save. */
  spotifyPlaylistId: string | null;
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
  spotify_playlist_id: string | null;
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
    spotifyPlaylistId: row.spotify_playlist_id,
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

export function saveSavedPaceProMix(mix: Omit<SavedPaceProMix, "id" | "savedAt" | "activityId" | "spotifyPlaylistId"> & { id?: string }): SavedPaceProMix {
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

export function setSavedPaceProMixPlaylist(id: string, spotifyPlaylistId: string | null): boolean {
  const result = getDb().prepare("UPDATE saved_pace_pro_mixes SET spotify_playlist_id = ? WHERE id = ?").run(spotifyPlaylistId, id);
  return result.changes > 0;
}

// Renames the local title only — the Spotify side (if a playlist is
// already linked) is a separate Spotify API call the route handler makes
// itself, since it needs a live access token this lib module doesn't have.
export function renameSavedPaceProMix(id: string, title: string): boolean {
  const result = getDb().prepare("UPDATE saved_pace_pro_mixes SET title = ? WHERE id = ?").run(title.trim(), id);
  return result.changes > 0;
}

// Clones a saved mix under a new title/id — everything about the source
// mix carries over (splits, timeline, track picks) EXCEPT its Spotify
// playlist link and attached GarminDB route/activity: those are specific
// associations the source mix earned through its own "Save to Spotify" /
// "attach route" actions, and silently aliasing them onto the duplicate
// would mean renaming or editing the duplicate later could reach back and
// mutate the original's linked playlist, or the duplicate would show a
// route that was never actually run for it.
export function duplicateSavedPaceProMix(id: string, title: string): SavedPaceProMix | null {
  const source = getSavedPaceProMix(id);
  if (!source) return null;
  const newId = `pp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const savedAt = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO saved_pace_pro_mixes (id, title, total_sec, timeline_json, splits_csv_text, file_name, saved_at, activity_id, spotify_playlist_id)
    VALUES (@id, @title, @totalSec, @timelineJson, @splitsCsvText, @fileName, @savedAt, NULL, NULL)
  `).run({
    id: newId, title: title.trim(), totalSec: source.totalSec, timelineJson: JSON.stringify(source.timeline),
    splitsCsvText: source.splitsCsvText, fileName: source.fileName, savedAt,
  });
  return getSavedPaceProMix(newId);
}

export function deleteSavedPaceProMix(id: string): void {
  getDb().prepare("DELETE FROM saved_pace_pro_mixes WHERE id = ?").run(id);
}
