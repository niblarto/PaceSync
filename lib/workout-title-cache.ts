import { getDb } from "@/lib/db";

// Remembers the most recent REAL title Runna's own ICS feed gave a workout
// on a given date — so if that date's VEVENT later disappears from the feed
// entirely (Runna appears to only emit a race's COMPLETED_PLAN_WORKOUT event
// once it's fully processed the result, same gap garminOrphanRun already
// exists to paper over — see lib/runna-schedule.ts), the Garmin-orphan
// fallback can still show "Robin Hood Half Marathon" instead of falling all
// the way back to Garmin's own raw activity name ("Nottingham Run" — a
// generic location-based name Garmin assigns, not the race's real title).
// Keyed by date only (not also by uid/type) — a date only ever has one
// "real" scheduled title worth remembering at a time, and the whole point
// is surviving that VEVENT's own disappearance, so nothing here can key off
// the VEVENT's uid once it's gone.

const KEY_PREFIX = "workout_title_cache:";

export function rememberWorkoutTitle(date: string, title: string): void {
  if (!title.trim()) return;
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(KEY_PREFIX + date, JSON.stringify({ title, rememberedAt: new Date().toISOString() }));
}

export function getRememberedWorkoutTitle(date: string): string | null {
  const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(KEY_PREFIX + date) as { value_json: string } | undefined;
  if (!row) return null;
  try {
    const data = JSON.parse(row.value_json) as { title?: string };
    return data.title ?? null;
  } catch {
    return null;
  }
}
