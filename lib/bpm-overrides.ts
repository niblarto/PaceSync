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

// "Work" segments don't use min/max/sweet: each pace from 6:50 to 8:55/mi
// (5s steps) gets one exact BPM, stored as `paceBpm` ("8:20" -> 172) in the
// same JSON blob. The mixer snaps a segment's pace to the nearest step.
export const PACE_BPM_MIN_SEC = 410; // 6:50
export const PACE_BPM_MAX_SEC = 535; // 8:55
export const PACE_BPM_STEP_SEC = 5;

export function paceBpmKey(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

export const PACE_BPM_KEYS: string[] = (() => {
  const keys: string[] = [];
  for (let s = PACE_BPM_MIN_SEC; s <= PACE_BPM_MAX_SEC; s += PACE_BPM_STEP_SEC) keys.push(paceBpmKey(s));
  return keys;
})();

export type BpmOverrides = Partial<Record<RunKind, { min?: number | null; max?: number | null; sweet?: number | null }>> & {
  paceBpm?: Record<string, number>;
};

// Usable BPM window for a run kind: its min/max override, or for "work" the
// per-pace BPMs' lowest value (less tolerance) and up. Unset sides are 0 /
// Infinity (no bound).
export function kindBpmRange(overrides: BpmOverrides, kind: RunKind): { min: number; max: number } {
  if (kind === "work") {
    const vals = Object.values(overrides.paceBpm ?? {}).filter(v => Number.isFinite(v) && v > 0);
    // A work segment accepts tracks up to 3 BPM below its target and has no
    // upper limit (running faster than target is never a mismatch), and its
    // exact-BPM lock can step out to neighbouring BPMs — so usable work
    // music is everything from the lowest table BPM less that tolerance up.
    if (vals.length > 0) return { min: Math.min(...vals) - 3, max: Infinity };
  }
  const o = overrides[kind];
  return {
    min: typeof o?.min === "number" ? o.min : 0,
    max: typeof o?.max === "number" ? o.max : Infinity,
  };
}

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
