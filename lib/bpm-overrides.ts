import { getDb } from "@/lib/db";

// Per-run-type BPM limits set on the Settings page. Empty/absent = no
// override (the mixer's automatic rules apply, e.g. the easy 168 ceiling);
// any value set here takes precedence. Compared against a track's effective
// running tempo (half-time tracks count at double).
//
// `sweet` is a different kind of value from min/max: it's a preference, not
// a limit. min/max are a hard filter in the mixer (ai_dj/workout.py's
// _segment_pool) — a track outside them is never selectable. sweet only
// sways which of the still-eligible tracks get ranked first as candidates;
// it never excludes anything on its own.
const KEY = "bpm_overrides";

export type RunKind = "warmup" | "work" | "easy" | "cooldown" | "rest";
export const RUN_KINDS: RunKind[] = ["warmup", "work", "easy", "cooldown", "rest"];

export type BpmOverrides = Partial<Record<RunKind, { min?: number | null; max?: number | null; sweet?: number | null }>>;

export function loadBpmOverrides(): BpmOverrides {
  const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(KEY) as { value_json: string } | undefined;
  if (!row) return {};
  try {
    return JSON.parse(row.value_json) as BpmOverrides;
  } catch {
    return {};
  }
}

export function saveBpmOverrides(overrides: BpmOverrides): void {
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(KEY, JSON.stringify(overrides));
}
