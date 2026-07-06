import fs from "fs";
import path from "path";

// Per-run-type BPM limits set on the Settings page. Empty/absent = no
// override (the mixer's automatic rules apply, e.g. the easy 168 ceiling);
// any value set here takes precedence. Compared against a track's effective
// running tempo (half-time tracks count at double).
const FILE = path.join(process.cwd(), "bpm-overrides.json");

export type RunKind = "warmup" | "work" | "easy" | "cooldown" | "rest";
export const RUN_KINDS: RunKind[] = ["warmup", "work", "easy", "cooldown", "rest"];

export type BpmOverrides = Partial<Record<RunKind, { min?: number | null; max?: number | null }>>;

export function loadBpmOverrides(): BpmOverrides {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf-8")) as BpmOverrides;
  } catch {
    return {};
  }
}

export function saveBpmOverrides(overrides: BpmOverrides): void {
  fs.writeFileSync(FILE, JSON.stringify(overrides), "utf-8");
}
