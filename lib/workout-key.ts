// Shared composite key for every store that links data to a specific Runna
// workout (todays-run-history, pinned-mixes, pinned-routes, race-splits).
// Date alone isn't unique — Runna reuses workout titles across weeks, and a
// single date can have multiple workout slots (e.g. a run + a strength
// session) — so every one of those stores keys by date+title instead. A
// single shared helper keeps all four stores' composite-key format identical
// (this matters directly: lib/pinned-mixes.ts's unpinMixesContaining()
// returns keys that get fed straight into lib/todays-run-history.ts's
// removeTodaysRunEntry(), so both sides must agree on the exact format).
export function workoutKey(date: string, title: string): string {
  return `${date}::${title}`;
}
