import { getPinnedRoute } from "@/lib/pinned-routes";
import { getPinnedMix } from "@/lib/pinned-mixes";
import { getSavedPaceProMix } from "@/lib/pace-pro-saved";
import type { AiDjMixResponse } from "@/lib/ai-dj-mix";

// /api/v1/schedule: each Runna workout gets the route pinned to it and its tracklist, so an outside assistant can show
// the map and the playlist for a run without calling anything else.
//   route:     the pinned route (a past run or a saved route), or the route of a linked Pace Pro mix
//   tracklist: the mix pinned to that workout, or else the linked Pace Pro mix

interface Workout { date?: string; title?: string; [k: string]: unknown }

// Google's encoded polyline format (precision 5): paste into a static-map URL or any polyline decoder.
function encodePolyline(pts: [number, number][]): string {
  let out = "", pLat = 0, pLng = 0;
  const enc = (v: number) => { let n = v < 0 ? ~(v << 1) : v << 1, s = ""; while (n >= 0x20) { s += String.fromCharCode((0x20 | (n & 0x1f)) + 63); n >>= 5; } return s + String.fromCharCode(n + 63); };
  for (const [lat, lng] of pts) { const la = Math.round(lat * 1e5), ln = Math.round(lng * 1e5); out += enc(la - pLat) + enc(ln - pLng); pLat = la; pLng = ln; }
  return out;
}

async function loadRoute(activityId: string, base: string, token: string) {
  try {
    const res = await fetch(`${base}/api/garmin/route/${encodeURIComponent(activityId)}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const d = await res.json() as { points?: number[][] };
    const all = (d.points ?? []).filter(p => typeof p[0] === "number" && typeof p[1] === "number");
    if (all.length < 2) return null;
    const step = Math.max(1, Math.ceil(all.length / 150));
    const pts = all.filter((_, i) => i % step === 0 || i === all.length - 1).map(p => [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5] as [number, number]);
    return { points: pts, polyline: encodePolyline(pts) };
  } catch { return null; }
}

function tracklist(source: string, title: string, totalSec: number, timeline: AiDjMixResponse["timeline"], id: string | null = null, playlistId: string | null = null) {
  return {
    source, id, title, spotifyPlaylistId: playlistId, spotifyPlaylistUrl: playlistId ? `https://open.spotify.com/playlist/${playlistId}` : null, totalSec: Math.round(totalSec),
    trackCount: timeline.reduce((n, s) => n + s.tracks.length, 0),
    segments: timeline.map(s => ({
      segment: s.segment, targetBpm: s.targetBpm, targetPaceSecPerMi: s.targetPaceSec ?? null,
      tracks: s.tracks.map(t => ({
        name: t.name, artist: t.artist, startsAt: t.startsAt, durationSec: t.durationSec ?? null, bpm: Math.round(t.tempo), key: t.camelot, energy: t.energy,
        spotifyUri: t.uri, spotifyUrl: t.uri.startsWith("spotify:track:") ? `https://open.spotify.com/track/${t.uri.slice(14)}` : null,
      })),
    })),
  };
}

export async function enrichSchedule(data: Record<string, unknown>, base: string, token: string): Promise<Record<string, unknown>> {
  const workouts = Array.isArray(data.workouts) ? data.workouts as Workout[] : [];
  const enriched = await Promise.all(workouts.map(async w => {
    if (!w.date || !w.title) return { ...w, paceProMixId: null, route: null, tracklist: null };
    let route: Record<string, unknown> | null = null;
    let list: ReturnType<typeof tracklist> | null = null;
    let paceProMixId: string | null = null;
    try {
      const pr = getPinnedRoute(w.date, w.title);
      const pinned = await getPinnedMix(w.date, w.title);
      if (pinned) list = tracklist("pinned-mix", `${w.title} mix`, pinned.totalSec, pinned.timeline);
      paceProMixId = pr?.paceProMixId ?? null;
      const mix = pr?.paceProMixId ? getSavedPaceProMix(pr.paceProMixId) : null;
      if (!list && mix) list = tracklist("pace-pro", mix.title, mix.totalSec, mix.timeline, mix.id, mix.spotifyPlaylistId);
      const routeId = pr?.activityId ?? null;
      if (routeId) {
        route = {
          id: routeId, name: pr!.name, distanceMi: pr!.distanceMi, source: routeId.startsWith("saved:") ? "saved-route" : "past-run",
          runDate: routeId.startsWith("saved:") ? null : pr!.runDate, activityId: routeId.startsWith("saved:") ? null : routeId, ...(await loadRoute(routeId, base, token) ?? { points: null, polyline: null }),
        };
      }
    } catch { /* a missing pin never breaks the schedule */ }
    return { ...w, paceProMixId, route, tracklist: list };
  }));
  return { ...data, workouts: enriched };
}
