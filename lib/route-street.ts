import type { LatLng } from "@/lib/ors";
import { getDb } from "@/lib/db";

// Looks a road up by name on OpenStreetMap (Overpass), near a point, for "include Acacia Way in the route". Only the
// road's name and the area around the start go out (a 15 km circle), the same service the traffic lights and parks come from.

const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const TTL_MS = 30 * 86_400_000;

// The road's points (thinned to about 150), or null when OpenStreetMap has no road of that name nearby / can't be reached.
export async function findStreet(name: string, near: LatLng, radiusM = 15000): Promise<LatLng[] | null> {
  const clean = name.replace(/[^A-Za-z0-9À-ɏ '.\-]/g, "").trim().slice(0, 60);
  if (clean.length < 3) return null;
  const re = clean.replace(/[.\-']/g, m => `\${m}`).replace(/ +/g, " +");
  const query = `[out:json][timeout:30];way["highway"]["name"~"^${re}$",i](around:${radiusM},${near[0]},${near[1]});out geom;`;
  // A road that was found before is remembered (a road doesn't move), so repeats don't call OpenStreetMap again.
  const cacheKey = `route_street:v1:${clean.toLowerCase()}:${near[0].toFixed(2)},${near[1].toFixed(2)}`;
  const db = getDb();
  const hit = db.prepare("SELECT value_json FROM kv_config WHERE key = ?").get(cacheKey) as { value_json: string } | undefined;
  if (hit) { try { const c = JSON.parse(hit.value_json) as { at: number; pts: LatLng[] }; if (Date.now() - c.at < TTL_MS) return c.pts; } catch { /* look it up again */ } }
  // Two passes over the mirrors: the public servers are often busy for a few seconds.
  for (const url of [...OVERPASS_URLS, ...OVERPASS_URLS.slice(0, 2)]) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "PaceSync-RouteFinder/1.0 (personal use)", Accept: "*/*" },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) continue;
      const data = await res.json() as { elements?: { type: string; geometry?: { lat: number; lon: number }[] }[] };
      const pts: LatLng[] = [];
      for (const el of data.elements ?? []) if (el.type === "way") for (const g of el.geometry ?? []) pts.push([g.lat, g.lon]);
      if (pts.length === 0) return [];
      const step = Math.max(1, Math.ceil(pts.length / 150));
      const out = pts.filter((_, i) => i % step === 0);
      db.prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json").run(cacheKey, JSON.stringify({ at: Date.now(), pts: out }));
      return out;
    } catch { continue; }
  }
  return null;
}
