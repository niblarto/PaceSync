import { loadBpmOverrides, RUN_KINDS } from "./bpm-overrides";

const DOUBLETIME_THRESHOLD = 95;

// The library's usable BPM coverage: the union of every run kind's
// configured min/max override (Settings), same source of truth as
// /api/settings/library-coverage and the AI DJ mixer. A kind with no
// override configured has no bound on that side, which would make the
// union unbounded if any kind is left fully open — in practice all 5 kinds
// are expected to have a max set.
export function libraryBpmRange(): { min: number; max: number } {
  const overrides = loadBpmOverrides();
  const bounds = RUN_KINDS.map(kind => {
    const o = overrides[kind];
    return {
      min: typeof o?.min === "number" ? o.min : 0,
      max: typeof o?.max === "number" ? o.max : Infinity,
    };
  });
  return {
    min: Math.min(...bounds.map(b => b.min)),
    max: Math.max(...bounds.map(b => b.max)),
  };
}

// True if tempo's effective (post-doubling) running tempo falls inside the
// library's usable BPM range — mirrors the doubling convention used by
// /api/settings/library-coverage and the AI DJ mixer: a sub-95 BPM track is
// read as double-time by a runner, so its usable BPM is the doubled value.
export function isWithinLibraryBpmRange(tempo: number): boolean {
  const { min, max } = libraryBpmRange();
  const effective = tempo < DOUBLETIME_THRESHOLD ? tempo * 2 : tempo;
  return effective >= min && effective <= max;
}
