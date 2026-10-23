import { getDb } from "@/lib/db";

// Street routing via OpenRouteService (https://openrouteservice.org, free API
// key, foot-walking profile). The key is saved on the Pi and never sent back to
// the browser. Everything passed to ORS — start/end, waypoints, a route's
// sampled points — leaves the Pi, so callers only use it when the user has
// asked for street routing.

const KEY = "ors_api_key";
const DIRECTIONS_URL = "https://api.openrouteservice.org/v2/directions/foot-walking/geojson";
const MAX_WAYPOINTS = 48; // ORS allows 50 per request
const SNAP_RADIUS_M = 100;

export type LatLng = [number, number];

export interface OrsRoute { points: LatLng[]; distanceM: number }
export type OrsResult = { ok: true; route: OrsRoute } | { ok: false; error: string };

export function loadOrsKey(): string | null {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(KEY) as { value_json: string } | undefined;
    const v = row ? JSON.parse(row.value_json) as string : null;
    if (v && v.trim()) return v.trim();
  } catch {}
  // Falls back to the ORS_API_KEY environment variable (.env.local on the Pi).
  const env = process.env.ORS_API_KEY;
  return env && env.trim() ? env.trim() : null;
}

export function saveOrsKey(key: string | null): void {
  const db = getDb();
  if (!key) db.prepare("DELETE FROM kv_config WHERE key = ?").run(KEY);
  else db.prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(KEY, JSON.stringify(key.trim()));
}

// The last rate-limit headers ORS sent back, so the UI can show what's left.
let rateInfo: { remaining: number; limit: number | null } | null = null;
export function orsRateInfo(): { remaining: number; limit: number | null } | null {
  return rateInfo;
}

async function post(body: object, key: string): Promise<OrsResult> {
  try {
    const res = await fetch(DIRECTIONS_URL, {
      method: "POST",
      headers: { Authorization: key, "Content-Type": "application/json", Accept: "application/geo+json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25_000),
    });
    const rem = parseInt(res.headers.get("x-ratelimit-remaining") ?? "");
    const lim = parseInt(res.headers.get("x-ratelimit-limit") ?? "");
    if (!isNaN(rem)) rateInfo = { remaining: rem, limit: isNaN(lim) ? null : lim };
    if (res.status === 401 || res.status === 403) return { ok: false, error: "OpenRouteService rejected the API key" };
    if (res.status === 429) return { ok: false, error: "OpenRouteService limit reached — wait a minute and try again" };
    if (!res.ok) {
      let detail = "";
      try { detail = ((await res.json()) as { error?: { message?: string } | string }).error as string ?? ""; } catch {}
      const msg = typeof detail === "string" ? detail : (detail as { message?: string })?.message ?? "";
      return { ok: false, error: `OpenRouteService error ${res.status}${msg ? `: ${msg}` : ""}` };
    }
    const data = await res.json() as {
      features?: { geometry: { coordinates: number[][] }; properties: { summary?: { distance?: number } } }[];
    };
    const f = data.features?.[0];
    if (!f) return { ok: false, error: "OpenRouteService returned no route" };
    return {
      ok: true,
      route: {
        points: f.geometry.coordinates.map(c => [c[1], c[0]] as LatLng),
        distanceM: f.properties.summary?.distance ?? 0,
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error && /timeout|abort/i.test(e.message) ? "OpenRouteService timed out" : "Couldn't reach OpenRouteService" };
  }
}

// A tiny fixed request (two points in central London, nowhere near the user)
// to check a key works before saving it.
export function testOrsKey(key: string): Promise<OrsResult> {
  return orsDirections([[51.5080, -0.1281], [51.5074, -0.1245]], key);
}

// A loop from `start` of about `lengthM` metres; different seeds give
// different loops (this is how RunPaths builds its candidates).
export function orsRoundTrip(start: LatLng, lengthM: number, seed: number, key: string): Promise<OrsResult> {
  return post({
    coordinates: [[start[1], start[0]]],
    options: { round_trip: { length: Math.round(lengthM), seed } },
  }, key);
}

// Street route through the given points in order.
export function orsDirections(coords: LatLng[], key: string): Promise<OrsResult> {
  const pts = coords.slice(0, MAX_WAYPOINTS);
  return post({
    coordinates: pts.map(c => [c[1], c[0]]),
    radiuses: pts.map(() => SNAP_RADIUS_M),
  }, key);
}

// At most MAX_WAYPOINTS points along a polyline, evenly spaced by distance,
// keeping the first and last — what's sent to ORS to snap a route to streets.
export function sampleWaypoints(points: LatLng[]): LatLng[] {
  if (points.length <= MAX_WAYPOINTS) return points;
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    const dy = (points[i][0] - points[i - 1][0]) * 110540;
    const dx = (points[i][1] - points[i - 1][1]) * 67000;
    cum.push(cum[i - 1] + Math.sqrt(dx * dx + dy * dy));
  }
  const total = cum[cum.length - 1];
  const out: LatLng[] = [points[0]];
  let j = 1;
  for (let k = 1; k < MAX_WAYPOINTS - 1; k++) {
    const want = (total * k) / (MAX_WAYPOINTS - 1);
    while (j < points.length - 1 && cum[j] < want) j++;
    out.push(points[j]);
  }
  out.push(points[points.length - 1]);
  return out;
}

// Run `fn` over `items` with at most `limit` in flight (ORS rate limits).
export async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) {
    workers.push((async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })());
  }
  await Promise.all(workers);
  return out;
}
