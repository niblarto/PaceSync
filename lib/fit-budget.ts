// Ports ai_dj/workout.py's _fit_duration_precise: a bounded combination
// search over an already-ranked pool for whichever subset lands closest to
// a target duration, rather than accepting the first greedy pass. Shared by
// replace-candidates-budget/route.ts (the multi-select chart remix) and
// lookup-fit/route.ts (fitting a user-picked candidate list from the
// "Lookup tracks" modal against a chart selection's combined duration) —
// both need the exact same "fill the gap as near as possible" rule, not two
// slightly different reimplementations of it.

const SHORT_BUDGET_SEC = 180; // <=3min budget: pick the single closest track, don't search sums
const DROP_ATTEMPTS = 8;
const SWAP_LOOKAHEAD = 8;

export function fitBudget<T extends { durationMs: number }>(pool: T[], budgetSec: number): T[] {
  if (pool.length === 0) return [];
  if (budgetSec <= SHORT_BUDGET_SEC) {
    let best = pool[0], bestMiss = Math.abs(pool[0].durationMs / 1000 - budgetSec);
    for (const t of pool) {
      const miss = Math.abs(t.durationMs / 1000 - budgetSec);
      if (miss < bestMiss) { best = t; bestMiss = miss; }
    }
    return [best];
  }

  const durations = pool.map(t => t.durationMs / 1000);
  const n = pool.length;
  const total = (positions: number[]) => positions.reduce((sum, p) => sum + durations[p], 0);

  const greedy: number[] = [];
  let cum = 0;
  let crossingPos: number | null = null;
  for (let pos = 0; pos < n; pos++) {
    const dur = durations[pos];
    if (cum + dur >= budgetSec) {
      crossingPos = pos;
      if (greedy.length === 0 || (cum + dur - budgetSec) < (budgetSec - cum)) greedy.push(pos);
      break;
    }
    greedy.push(pos);
    cum += dur;
  }

  const candidates: number[][] = [greedy];

  if (crossingPos !== null) {
    const base = greedy.filter(p => p !== crossingPos);
    for (let look = crossingPos + 1; look < Math.min(crossingPos + 1 + SWAP_LOOKAHEAD, n); look++) {
      candidates.push([...base, look]);
    }
  }

  const pickedSet = new Set(greedy);
  const unpicked = Array.from({ length: n }, (_, i) => i).filter(p => !pickedSet.has(p));
  for (const dropPos of greedy.slice(-DROP_ATTEMPTS).reverse()) {
    const reduced = greedy.filter(p => p !== dropPos);
    const reducedTotal = total(reduced);
    if (reducedTotal >= budgetSec) { candidates.push(reduced); continue; }
    for (const fillPos of unpicked.slice(0, SWAP_LOOKAHEAD)) {
      if (reduced.includes(fillPos)) continue;
      candidates.push([...reduced, fillPos]);
    }
  }

  const miss = (positions: number[]) => Math.abs(total(positions) - budgetSec);
  const best = candidates.reduce((a, b) => (miss(b) < miss(a) ? b : a));
  return best.slice().sort((a, b) => a - b).map(p => pool[p]);
}
