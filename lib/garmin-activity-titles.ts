import { getDb } from "@/lib/db";

// User-given display titles for Garmin activities — see lib/db.ts's own
// comment on the garmin_activity_titles table for why this is a separate
// override table in pacesync.db rather than an edit to GarminDB itself.
// Applied by callers at read time: overlay onto GarminDB's own
// activities.name for display, never replace it in the source data.

interface Row {
  activity_id: string;
  title: string;
  updated_at: string;
}

export function getActivityTitleOverrides(activityIds: string[]): Map<string, string> {
  if (activityIds.length === 0) return new Map();
  const placeholders = activityIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT activity_id, title FROM garmin_activity_titles WHERE activity_id IN (${placeholders})`)
    .all(...activityIds) as Pick<Row, "activity_id" | "title">[];
  return new Map(rows.map(r => [r.activity_id, r.title]));
}

export function getActivityTitleOverride(activityId: string): string | null {
  const row = getDb().prepare("SELECT title FROM garmin_activity_titles WHERE activity_id = ?").get(activityId) as Pick<Row, "title"> | undefined;
  return row?.title ?? null;
}

export function setActivityTitleOverride(activityId: string, title: string): void {
  const trimmed = title.trim();
  if (!trimmed) {
    // Blank input clears the override (reverts to GarminDB's own name)
    // rather than storing an empty title.
    getDb().prepare("DELETE FROM garmin_activity_titles WHERE activity_id = ?").run(activityId);
    return;
  }
  getDb().prepare(`
    INSERT INTO garmin_activity_titles (activity_id, title, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(activity_id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at
  `).run(activityId, trimmed, new Date().toISOString());
}

export function clearActivityTitleOverride(activityId: string): void {
  getDb().prepare("DELETE FROM garmin_activity_titles WHERE activity_id = ?").run(activityId);
}
