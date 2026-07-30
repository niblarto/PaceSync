import fs from "fs";
import path from "path";
import type { AiDjMixResponse } from "@/lib/ai-dj-mix";
import { workoutKey } from "@/lib/workout-key";

// Mixes pinned to a workout date+title (see lib/workout-key.ts) from the
// dashboard. The nightly AI DJ pre-build uses a pinned mix for that workout
// verbatim instead of generating a fresh one. Pruned once the date is more
// than a week past.

const FILE = path.join(process.cwd(), "pinned-mixes.json");
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

// Survives a pin's deletion (unpin/eject) so a stale, still-in-flight
// build response from BEFORE the unpin can't silently re-create it
// afterward — see CURSOR_FILE below. Keyed the same as the main pin store.
const CURSOR_FILE = path.join(process.cwd(), "pinned-mixes-cursor.json");

function loadDeleteCursors(): Record<string, number> {
  try {
    return JSON.parse(fs.readFileSync(CURSOR_FILE, "utf-8")) as Record<string, number>;
  } catch {
    return {};
  }
}

function saveDeleteCursors(cursors: Record<string, number>): void {
  fs.writeFileSync(CURSOR_FILE, JSON.stringify(cursors), "utf-8");
}

function loadAll(): Record<string, PinnedMix> {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf-8")) as Record<string, PinnedMix>;
  } catch {
    return {};
  }
}

function saveAll(all: Record<string, PinnedMix>): void {
  const cutoff = Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000;
  Object.entries(all).forEach(([key, mix]) => {
    if (new Date(mix.date + "T12:00:00").getTime() < cutoff) delete all[key];
  });
  fs.writeFileSync(FILE, JSON.stringify(all), "utf-8");
}

// Every exported mutator below does read-whole-file -> modify -> write-
// whole-file as two separate synchronous fs calls. Two concurrent requests
// (e.g. a slow "Fill the gap" build's pin POST landing well after a faster,
// later-started one) can each read the file before the other writes, then
// both write their own full snapshot — whichever writes last wins outright,
// silently reverting everything else in the file even though both requests
// log "success". The per-key startedAtMs check above only protects a
// single key's value; it can't stop this whole-file lost-update race. This
// queue serializes every mutating call (and getPinnedMix, so a read can't
// interleave either) so only one is ever in flight against the file at a
// time, regardless of how the underlying work is scheduled.
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => T): Promise<T> {
  const result = queue.then(fn, fn);
  queue = result.catch(() => {});
  return result;
}

export async function getPinnedMix(date: string, title: string): Promise<PinnedMix | null> {
  return serialize(() => loadAll()[workoutKey(date, title)] ?? null);
}

// Rejects (no-op, returns false) a write whose startedAtMs is older than
// either the currently-stored pin's startedAtMs or the workout's delete
// cursor (set by removePinnedMix) — closes the race where an
// earlier-started build's pin POST resolves after a later-started one and
// would otherwise clobber it, or resurrects a pin the user just explicitly
// unpinned. A write with no startedAtMs at all (manual "Pin to
// workout"/re-pin) always applies.
export async function setPinnedMix(entry: PinnedMix): Promise<boolean> {
  return serialize(() => {
    const key = workoutKey(entry.date, entry.workoutTitle);
    const all = loadAll();
    if (entry.startedAtMs !== undefined) {
      const existing = all[key]?.startedAtMs;
      if (existing !== undefined && existing > entry.startedAtMs) return false;
      const deletedAt = loadDeleteCursors()[key];
      if (deletedAt !== undefined && deletedAt > entry.startedAtMs) return false;
    }
    all[key] = entry;
    saveAll(all);
    return true;
  });
}

export async function removePinnedMix(date: string, title: string, atMs?: number): Promise<void> {
  return serialize(() => {
    const key = workoutKey(date, title);
    const all = loadAll();
    delete all[key];
    saveAll(all);
    if (atMs !== undefined) {
      const cursors = loadDeleteCursors();
      cursors[key] = Math.max(cursors[key] ?? 0, atMs);
      saveDeleteCursors(cursors);
    }
  });
}

// Unpins every pinned mix that contains any of the given track URIs — used
// when a track is deleted from the library, so a pinned mix can never keep
// pointing at a track that no longer exists, regardless of which mix (if
// any) happens to be loaded in the browser at the time. Returns the
// {date, title} pairs that were unpinned, so callers can also drop their
// history snapshot via removeTodaysRunEntry(date, title) — both stores key
// by the same workoutKey() format, so this pairing is required, not optional.
// atMs stamps the same delete cursor removePinnedMix does, so a build that
// was already in flight before this delete can't land afterward and
// silently re-pin a mix containing the just-deleted track.
export async function unpinMixesContaining(uris: string[], atMs?: number): Promise<{ date: string; title: string }[]> {
  if (uris.length === 0) return [];
  return serialize(() => {
    const uriSet = new Set(uris);
    const all = loadAll();
    const affected: { date: string; title: string }[] = [];
    const affectedKeys: string[] = [];
    for (const [key, mix] of Object.entries(all)) {
      const hasMatch = mix.timeline.some(seg => seg.tracks.some(t => t.uri && uriSet.has(t.uri)));
      if (hasMatch) {
        affected.push({ date: mix.date, title: mix.workoutTitle });
        affectedKeys.push(key);
      }
    }
    if (affectedKeys.length > 0) {
      for (const key of affectedKeys) delete all[key];
      saveAll(all);
      if (atMs !== undefined) {
        const cursors = loadDeleteCursors();
        for (const key of affectedKeys) cursors[key] = Math.max(cursors[key] ?? 0, atMs);
        saveDeleteCursors(cursors);
      }
    }
    return affected;
  });
}
