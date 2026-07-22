import fs from "fs";
import path from "path";

// Every AI DJ mix build (remix or first build, saved or not) for a workout
// date, so a remix — or a reload mid-remix-chain, or the overnight cron —
// still demotes tracks from recent attempts instead of starting fresh each
// time. Distinct from todays-run-history.ts's "confirmed played" log (which
// only gets a row once a mix is actually saved/pinned): this fires on every
// build attempt, whether saved or not, since the point is variety across
// remixes, not tracking what actually got listened to.

const FILE = path.join(process.cwd(), "recent-mix-builds.json");
const RETAIN_DAYS = 3; // only recent remix history matters for freshness
const MAX_BUILDS_PER_DATE = 8; // cap so a long remix session can't grow this file unbounded

interface Store {
  [date: string]: { builtAt: string; uris: string[] }[];
}

function loadAll(): Store {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf-8")) as Store;
  } catch {
    return {};
  }
}

// Records one build's track URIs against its workout date. Called after
// every successful mix build (see app/api/ai-dj/mix/route.ts).
export function recordMixBuild(date: string, uris: string[]): void {
  if (!date || uris.length === 0) return;
  try {
    const all = loadAll();
    const list = all[date] ?? [];
    list.push({ builtAt: new Date().toISOString(), uris });
    all[date] = list.slice(-MAX_BUILDS_PER_DATE);

    const cutoff = Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000;
    Object.keys(all).forEach(d => {
      if (new Date(d + "T12:00:00").getTime() < cutoff) delete all[d];
    });

    fs.writeFileSync(FILE, JSON.stringify(all), "utf-8");
  } catch (e) {
    console.warn("[recent-mix-builds] save failed:", e);
  }
}

// Every URI built for this date across all recent attempts — merged with
// the client's own accumulated avoidUris so a page reload doesn't lose the
// exclusion chain, and the overnight cron (which has no client state at
// all) still avoids repeating its own most recent attempt for the same date.
export function getRecentBuildUris(date: string): string[] {
  if (!date) return [];
  const list = loadAll()[date] ?? [];
  return Array.from(new Set(list.flatMap(b => b.uris)));
}
