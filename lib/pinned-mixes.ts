import { getDb } from "@/lib/db";
import type { AiDjMixResponse } from "@/lib/ai-dj-mix";

// Mixes pinned to a workout date+title from the dashboard. The nightly AI
// DJ pre-build uses a pinned mix for that workout verbatim instead of
// generating a fresh one. Pruned once the date is more than a week past.

const RETAIN_DAYS = 7;

export interface PinnedMix {
  date: string;           // workout date YYYY-MM-DD
  workoutTitle: string;
  totalSec: number;
  timeline: AiDjMixResponse["timeline"];
  pinnedAt: string;       // ISO timestamp
  // Wall-clock time (client Date.now(), captured when the build STARTED,
  // not when it finished) attached by an automated pin (fresh build/remix/
  // fill-the-gap). undefined for a manual "Pin to workout" click or a
  // re-pin from history — those are the user's explicit latest intent and
  // always win regardless of timing. A real timestamp (rather than an
  // in-memory per-workout counter) survives page reloads/component
  // remounts/server restarts with nothing to reset or resynchronize — the
  // server always has an absolute reference to compare against.
  startedAtMs?: number;
}

interface Row {
  date: string;
  workout_title: string;
  total_sec: number;
  timeline_json: string;
  pinned_at: string;
  started_at_ms: number | null;
}

function rowToMix(r: Row): PinnedMix {
  return {
    date: r.date,
    workoutTitle: r.workout_title,
    totalSec: r.total_sec,
    timeline: JSON.parse(r.timeline_json) as AiDjMixResponse["timeline"],
    pinnedAt: r.pinned_at,
    startedAtMs: r.started_at_ms ?? undefined,
  };
}

function pruneOld(): void {
  const cutoffIso = new Date(Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  getDb().prepare("DELETE FROM pinned_mixes WHERE date < ?").run(cutoffIso);
}

// Normalizes a timeline before it's ever written: dedupes tracks by uri
// (a track can legitimately appear in more than one segment — the mixer
// doesn't hard-exclude a track once placed) and recomputes every
// remaining track's startsAt from scratch in final play order. Applied
// unconditionally inside setPinnedMix so every write path is normalized
// here once, rather than trusting each caller to have already deduped and
// retimed its own timeline (a client-side dedupeTimeline existed for this
// but a route re-pinning a stale/raw timeline — e.g. "Save to Today's
// Run" sending aiDjMix.timeline as-is — bypassed it, leaving every track
// after a removed one with a stale, too-early startsAt that then fed the
// wrong offsets into the route-map's song-position overlay).
function dedupeAndRetimeTimeline(timeline: AiDjMixResponse["timeline"]): AiDjMixResponse["timeline"] {
  const seen = new Set<string>();
  const deduped = timeline
    .map(seg => ({ ...seg, tracks: seg.tracks.filter(t => (seen.has(t.uri) ? false : (seen.add(t.uri), true))) }))
    .filter(seg => seg.tracks.length > 0);
  const toSec = (mmss: string) => {
    const p = mmss.split(":").map(Number);
    return p.some(isNaN) ? 0 : p.reduce((acc, x) => acc * 60 + x, 0);
  };
  const toMmss = (sec: number) => {
    const m = Math.floor(sec / 60), s = Math.round(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  };
  let cursorSec = 0;
  return deduped.map(seg => ({
    ...seg,
    tracks: seg.tracks.map(t => {
      const startsAt = toMmss(cursorSec);
      cursorSec += t.durationSec ?? toSec(t.startsAt);
      return { ...t, startsAt };
    }),
  }));
}

export async function getPinnedMix(date: string, title: string): Promise<PinnedMix | null> {
  const row = getDb().prepare("SELECT * FROM pinned_mixes WHERE date = ? AND workout_title = ?").get(date, title) as Row | undefined;
  return row ? rowToMix(row) : null;
}

// Rejects (no-op, returns false) a write whose startedAtMs is older than
// either the currently-stored pin's startedAtMs or the workout's delete
// cursor (set by removePinnedMix) — closes the race where an
// earlier-started build's pin POST resolves after a later-started one and
// would otherwise clobber it, or resurrects a pin the user just explicitly
// unpinned. A write with no startedAtMs at all (manual "Pin to
// workout"/re-pin) always applies.
//
// The read-check-write here is wrapped in a single SQLite transaction
// (db.transaction — synchronous, serializes automatically at the SQLite
// level) rather than the in-process serialize() promise-queue the JSON-era
// store used — a strictly stronger guarantee (also correct across multiple
// connections/processes, not just within one), and simpler code.
export async function setPinnedMix(entry: PinnedMix): Promise<boolean> {
  const db = getDb();
  const tx = db.transaction((entry: PinnedMix): boolean => {
    if (entry.startedAtMs !== undefined) {
      const existing = db.prepare("SELECT started_at_ms FROM pinned_mixes WHERE date = ? AND workout_title = ?")
        .get(entry.date, entry.workoutTitle) as { started_at_ms: number | null } | undefined;
      if (existing?.started_at_ms != null && existing.started_at_ms > entry.startedAtMs) return false;
      const cursor = db.prepare("SELECT deleted_at_ms FROM pinned_mixes_cursor WHERE date = ? AND workout_title = ?")
        .get(entry.date, entry.workoutTitle) as { deleted_at_ms: number } | undefined;
      if (cursor !== undefined && cursor.deleted_at_ms > entry.startedAtMs) return false;
    }
    const timeline = dedupeAndRetimeTimeline(entry.timeline);
    db.prepare(
      "INSERT INTO pinned_mixes (date, workout_title, total_sec, timeline_json, pinned_at, started_at_ms) VALUES (?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(date, workout_title) DO UPDATE SET total_sec = excluded.total_sec, timeline_json = excluded.timeline_json, pinned_at = excluded.pinned_at, started_at_ms = excluded.started_at_ms"
    ).run(entry.date, entry.workoutTitle, entry.totalSec, JSON.stringify(timeline), entry.pinnedAt, entry.startedAtMs ?? null);
    return true;
  });
  const result = tx(entry);
  if (result) pruneOld();
  return result;
}

// Removes any pinned mix dated today-or-later whose (date, title) no
// longer matches a workout in the live Runna schedule — the ICS feed is
// the source of truth, so a pin surviving an edit that renamed/removed its
// slot (e.g. "3.75mi Easy Run" swapped for "4.5mi Easy Run" on the same
// day) is stale and must go, not linger until manually noticed. Deliberately
// scoped to future (>= today) dates only: a PAST date's pin is a permanent
// record of what a completed run actually used (same invariant
// lib/todays-run-history.ts enforces for its own store) and must never be
// swept just because the calendar later changed — only an unplayed,
// still-upcoming pin can be considered stale relative to the current feed.
export function pruneStalePinsAgainstSchedule(liveWorkouts: { date: string; title: string }[]): void {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.prepare("SELECT date, workout_title FROM pinned_mixes WHERE date >= ?").all(today) as { date: string; workout_title: string }[];
  if (rows.length === 0) return;

  const live = new Set(liveWorkouts.map(w => `${w.date}|||${w.title}`));
  const del = db.prepare("DELETE FROM pinned_mixes WHERE date = ? AND workout_title = ?");
  const tx = db.transaction(() => {
    for (const r of rows) {
      if (!live.has(`${r.date}|||${r.workout_title}`)) del.run(r.date, r.workout_title);
    }
  });
  tx();
}

export async function removePinnedMix(date: string, title: string, atMs?: number): Promise<void> {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM pinned_mixes WHERE date = ? AND workout_title = ?").run(date, title);
    if (atMs !== undefined) {
      const existing = db.prepare("SELECT deleted_at_ms FROM pinned_mixes_cursor WHERE date = ? AND workout_title = ?")
        .get(date, title) as { deleted_at_ms: number } | undefined;
      const next = Math.max(existing?.deleted_at_ms ?? 0, atMs);
      db.prepare(
        "INSERT INTO pinned_mixes_cursor (date, workout_title, deleted_at_ms) VALUES (?, ?, ?) " +
        "ON CONFLICT(date, workout_title) DO UPDATE SET deleted_at_ms = excluded.deleted_at_ms"
      ).run(date, title, next);
    }
  });
  tx();
}

// Unpins every UPCOMING (not-yet-run) pinned mix that contains any of the
// given track URIs — used when a track is deleted from the library, so a
// mix for a workout that hasn't happened yet can never keep pointing at a
// track that no longer exists. Deliberately leaves PAST workouts' pins
// alone: a pinned mix for a date before today is a historical record of
// what actually played, not a still-changeable plan — deleting a track
// from the library afterward shouldn't silently rewrite that history.
// Returns the {date, title} pairs that were unpinned, so callers can also
// drop their history snapshot via removeTodaysRunEntry(date, title) — both
// stores key by (date, workout_title), so this pairing is required, not
// optional. atMs stamps the same delete cursor removePinnedMix does, so a
// build that was already in flight before this delete can't land
// afterward and silently re-pin a mix containing the just-deleted track.
export async function unpinMixesContaining(uris: string[], atMs?: number): Promise<{ date: string; title: string }[]> {
  if (uris.length === 0) return [];
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const tx = db.transaction((): { date: string; title: string }[] => {
    const uriSet = new Set(uris);
    const rows = db.prepare("SELECT * FROM pinned_mixes WHERE date >= ?").all(today) as Row[];
    const affected: { date: string; title: string }[] = [];
    const del = db.prepare("DELETE FROM pinned_mixes WHERE date = ? AND workout_title = ?");
    const upsertCursor = db.prepare(
      "INSERT INTO pinned_mixes_cursor (date, workout_title, deleted_at_ms) VALUES (?, ?, ?) " +
      "ON CONFLICT(date, workout_title) DO UPDATE SET deleted_at_ms = MAX(deleted_at_ms, excluded.deleted_at_ms)"
    );
    for (const row of rows) {
      const mix = rowToMix(row);
      const hasMatch = mix.timeline.some(seg => seg.tracks.some(t => t.uri && uriSet.has(t.uri)));
      if (!hasMatch) continue;
      affected.push({ date: mix.date, title: mix.workoutTitle });
      del.run(mix.date, mix.workoutTitle);
      if (atMs !== undefined) upsertCursor.run(mix.date, mix.workoutTitle, atMs);
    }
    return affected;
  });
  return tx();
}
