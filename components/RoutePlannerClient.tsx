"use client";

import { TopNav } from "@/components/TopNav";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import "leaflet/dist/leaflet.css";
import { buildTimeline, fmtClock, fmtPace, paceColor, parseWorkoutSteps, positionAt, type Timeline } from "@/lib/workout-steps";

// Suggests new routes of a chosen distance, stitched together from the paths
// in your own recorded runs (/api/garmin/route-suggestions). Click the map to
// place a start (and optionally a different end); with no end it's a loop.

interface Candidate {
  points: [number, number][];
  distanceMi: number;
  overlapPct: number;
  familiarPct: number;
  compactness: number;
  isLoop: boolean;
  score?: number;
  source?: "runs" | "streets" | "gpx";
  snapped?: boolean;
  lights?: number | null;
  parkPct?: number | null;
}

interface SavedRoute {
  id: string;
  name: string;
  distanceMi: number;
  createdAt: string;
  source: "runs" | "streets" | "gpx";
  snapped: boolean;
  isLoop: boolean;
}

// An upcoming scheduled workout (from /api/runna/workouts) that can be laid over a route.
interface UpcomingWorkout { uid: string; date: string; title: string; type: string; distanceMi: number | null; durationSec: number; segments: string[] }

interface RunActivity { id: string | number; name: string | null; startTime: string | null; distanceMi: number | null; sport?: string | null }

type LatLng = [number, number];
type PickMode = "start" | "end" | "via" | null;

// A waypoint is a circle this big: the route passes through the busiest point
// inside it, and the tooltip counts the runs through it (must match the server).
const WAYPOINT_RADIUS_M = 50;
const PLAY_MI_PER_SEC = 0.5;
const M_PER_MI = 1609.344;

function segMi(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]), dLng = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return (6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))) / M_PER_MI;
}

function cumulativeMi(points: LatLng[]): number[] {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + segMi(points[i - 1], points[i]));
  return cum;
}

// Position and compass bearing (0 = north, clockwise) `mi` miles along the route.
function pointAt(points: LatLng[], cum: number[], mi: number): { pos: LatLng; bearing: number } {
  let i = 1;
  while (i < points.length - 1 && cum[i] < mi) i++;
  const a = points[i - 1], b = points[i];
  const span = cum[i] - cum[i - 1];
  const t = span > 0 ? Math.min(1, Math.max(0, (mi - cum[i - 1]) / span)) : 1;
  const bearing = (Math.atan2((b[1] - a[1]) * Math.cos((a[0] * Math.PI) / 180), b[0] - a[0]) * 180) / Math.PI;
  return { pos: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], bearing };
}

const ARROW_HTML = '<div style="width:26px;height:26px"><svg width="26" height="26" viewBox="0 0 24 24"><path d="M12 2 L20 21 L12 16 L4 21 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg></div>';

const COLORS = ["#22c55e", "#3b82f6", "#f97316", "#a855f7", "#ec4899", "#06b6d4"];

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Tracks (or, failing that, routes) in a GPX file, one entry each with at
// least two points. Elevation and time are ignored.
function parseGpx(xml: string, fallbackName: string): { name: string; points: LatLng[] }[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) throw new Error("not a valid GPX file");
  const pointsOf = (el: Element, tag: string): LatLng[] =>
    Array.from(el.getElementsByTagName(tag))
      .map(n => [parseFloat(n.getAttribute("lat") ?? ""), parseFloat(n.getAttribute("lon") ?? "")] as LatLng)
      .filter(p => !isNaN(p[0]) && !isNaN(p[1]));
  const nameOf = (el: Element): string =>
    Array.from(el.children).find(c => c.localName === "name")?.textContent?.trim() ?? "";
  const out: { name: string; points: LatLng[] }[] = [];
  for (const [tag, ptTag] of [["trk", "trkpt"], ["rte", "rtept"]] as const) {
    const els = Array.from(doc.getElementsByTagName(tag));
    els.forEach((el, i) => {
      const points = pointsOf(el, ptTag);
      if (points.length >= 2) out.push({ name: nameOf(el) || (els.length > 1 ? `${fallbackName} ${i + 1}` : fallbackName), points });
    });
    if (out.length > 0) break;
  }
  return out;
}

// Evenly thinned to at most `max` points, keeping the first and last.
function thinPoints(points: LatLng[], max: number): LatLng[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  const out: LatLng[] = [];
  for (let i = 0; i < max - 1; i++) out.push(points[Math.round(i * step)]);
  out.push(points[points.length - 1]);
  return out;
}

function toGpx(c: Candidate, name: string): string {
  const pts = c.points.map(p => `<trkpt lat="${p[0].toFixed(6)}" lon="${p[1].toFixed(6)}"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="PaceSync" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${escapeXml(name)}</name><trkseg>${pts}</trkseg></trk></gpx>`;
}

export function RoutePlannerClient({ initialDistance, autoSearch, initialWorkout }: { initialDistance?: string; autoSearch?: boolean; initialWorkout?: string } = {}) {
  const mapDivRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import("leaflet").Map | null>(null);
  const tilesRef = useRef<{ street: import("leaflet").TileLayer; satellite: import("leaflet").TileLayer } | null>(null);
  const layersRef = useRef<import("leaflet").Layer[]>([]);
  const markersRef = useRef<import("leaflet").Layer[]>([]);
  const [mapReady, setMapReady] = useState(false);
  const [view, setView] = useState<"street" | "satellite">("street");
  const [distance, setDistance] = useState(initialDistance ?? "6");
  // Only paths run at least this many times are used — single-run GPS wobble
  // (e.g. a trace through back gardens) can't become a shortcut.
  const [minRuns, setMinRuns] = useState("2");
  // Which of your activities the paths are taken from: runs, walks, or both (at least one is always ticked).
  const [useRuns, setUseRuns] = useState(true);
  const [useWalks, setUseWalks] = useState(false);
  const kinds = useRuns && useWalks ? "both" : useWalks ? "walks" : "runs";
  const kindsRef = useRef(kinds);
  kindsRef.current = kinds;
  // "runs": loops stitched from your own GPS history. "streets": brand-new
  // routes on real streets from a start/end (OpenRouteService).
  const [sourceMode, setSourceMode] = useState<"runs" | "streets" | "draw">("runs");
  const sourceModeRef = useRef<"runs" | "streets" | "draw">("runs");
  sourceModeRef.current = sourceMode;
  const [snap, setSnap] = useState(false);
  const [avoidLights, setAvoidLights] = useState(false);
  const [preferParks, setPreferParks] = useState(false);
  const [orsHasKey, setOrsHasKey] = useState<boolean | null>(null);
  const [routes, setRoutes] = useState<Candidate[] | null>(null);
  const [runs, setRuns] = useState<number | null>(null);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [home, setHome] = useState<LatLng | null>(null);
  const [homeLoaded, setHomeLoaded] = useState(false);
  const autoRanRef = useRef(false);
  const [start, setStart] = useState<LatLng | null>(null);
  const [end, setEnd] = useState<LatLng | null>(null);
  const [mode, setMode] = useState<PickMode>(null);
  // Waypoints you place; the route passes through them in the order added.
  const [via, setVia] = useState<LatLng[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [homeMsg, setHomeMsg] = useState<string | null>(null);
  // Activities left out of the path graph (e.g. closed-road races).
  const [activities, setActivities] = useState<RunActivity[]>([]);
  const [savedExcluded, setSavedExcluded] = useState<Set<string>>(new Set());
  const [draftExcluded, setDraftExcluded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [excludeOpen, setExcludeOpen] = useState(false);
  const [excludeSaving, setExcludeSaving] = useState(false);
  const [onlyExcluded, setOnlyExcluded] = useState(false);
  // A clicked stretch of route and the runs that pass through it.
  const [section, setSection] = useState<{ pt: LatLng; loading: boolean; acts: RunActivity[]; error?: string } | null>(null);
  const modeRef = useRef<PickMode>(null);
  modeRef.current = mode;
  const centredRef = useRef(false);
  // Routes saved for later (and for pinning to a scheduled run).
  const [saved, setSaved] = useState<SavedRoute[]>([]);
  const [savedOpen, setSavedOpen] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState<Set<number>>(new Set());
  // While placing a waypoint: a circle follows the cursor with a count of the
  // runs that pass through it.
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
  const hoverCircleRef = useRef<import("leaflet").Circle | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverSeqRef = useRef(0);
  // Play button: an arrow travels the selected route at PLAY_MI_PER_SEC.
  const [playing, setPlaying] = useState(false);
  const [playMi, setPlayMi] = useState(0);
  const playMiRef = useRef(0);
  const arrowRef = useRef<import("leaflet").Marker | null>(null);
  // A scheduled workout laid over the route: its steps colour the route and the arrow runs each at that step's pace.
  const [workouts, setWorkouts] = useState<UpcomingWorkout[]>([]);
  const [planUid, setPlanUid] = useState("");
  const [playSpeed, setPlaySpeed] = useState(60);   // simulated seconds per real second
  const [playSec, setPlaySec] = useState(0);
  const playSecRef = useRef(0);
  const planLayersRef = useRef<import("leaflet").Layer[]>([]);

  // Upcoming workouts that include some running (Runna's feed keeps the next few weeks).
  useEffect(() => {
    fetch("/api/runna/workouts")
      .then(r => r.json())
      .then((d: { workouts?: UpcomingWorkout[] }) => {
        const today = new Date();
        const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
        const list = (d.workouts ?? []).filter(w => w.date >= todayStr && w.type !== "strength" && w.type !== "rest").sort((a, b) => a.date.localeCompare(b.date));
        setWorkouts(list);
        if (initialWorkout && list.some(w => w.uid === initialWorkout)) setPlanUid(initialWorkout);
      })
      .catch(() => {});
  }, []);

  const selectedRoute = routes?.[selected] ?? null;
  const timeline: Timeline | null = useMemo(() => {
    const w = workouts.find(x => x.uid === planUid);
    if (!w || !selectedRoute) return null;
    const steps = parseWorkoutSteps(w.segments, { distanceMi: w.distanceMi, durationSec: w.durationSec });
    if (steps.length === 0) return null;
    const cum = cumulativeMi(selectedRoute.points);
    return buildTimeline(steps, cum[cum.length - 1]);
  }, [workouts, planUid, selectedRoute]);

  // "Draw route": click points on the map and each is joined to the last (along paths you've run, or real streets).
  const [drawFollow, setDrawFollow] = useState(true);
  const [drawClicks, setDrawClicks] = useState<LatLng[]>([]);                    // where you clicked
  const [drawWaypoints, setDrawWaypoints] = useState<{ pos: LatLng; exact: boolean }[]>([]); // where the route really passes
  const [drawLegs, setDrawLegs] = useState<{ points: LatLng[]; follow: boolean }[]>([]);
  const [drawBusy, setDrawBusy] = useState(false);
  const drawBusyRef = useRef(false);
  const drawMarkersRef = useRef<import("leaflet").Layer[]>([]);
  const addDrawPointRef = useRef<(p: LatLng) => void>(() => {});

  async function fetchLeg(from: { pos: LatLng; exact: boolean }, to: LatLng, follow: boolean): Promise<{ points: LatLng[]; start: LatLng; end: LatLng } | { error: string }> {
    try {
      const res = await fetch("/api/garmin/route-draw", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: from.pos, to, follow, minRuns: parseInt(minRuns) || 2, exactFrom: follow && from.exact, kinds: kindsRef.current }),
      });
      const d = await res.json() as { points?: LatLng[]; start?: LatLng; end?: LatLng; error?: string };
      if (!res.ok || !d.points || !d.start || !d.end) return { error: d.error ?? `HTTP ${res.status}` };
      return { points: d.points, start: d.start, end: d.end };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  async function addDrawPoint(p: LatLng) {
    if (drawBusyRef.current) return;
    const last = drawWaypoints[drawWaypoints.length - 1];
    if (!last) { setDrawWaypoints([{ pos: p, exact: false }]); setDrawClicks([p]); return; }
    drawBusyRef.current = true; setDrawBusy(true); setError(null);
    const follow = drawFollow;
    const r = await fetchLeg(last, p, follow);
    drawBusyRef.current = false; setDrawBusy(false);
    if ("error" in r) { setError(r.error); return; }
    setDrawLegs(l => [...l, { points: r.points, follow }]);
    setDrawWaypoints(w => [...(w.length === 1 ? [{ pos: r.start, exact: follow }] : w), { pos: r.end, exact: follow }]);
    setDrawClicks(c => [...c, p]);
  }
  addDrawPointRef.current = p => { void addDrawPoint(p); };

  // Re-joins every clicked point with the other routing (when "Follow my routes" is flipped).
  async function rerouteDraw(follow: boolean) {
    const clicks = drawClicks;
    if (clicks.length < 2 || drawBusyRef.current) return;
    drawBusyRef.current = true; setDrawBusy(true); setError(null);
    let from = { pos: clicks[0], exact: false };
    const legs: { points: LatLng[]; follow: boolean }[] = [];
    const wps = [from];
    for (let i = 1; i < clicks.length; i++) {
      const r = await fetchLeg(from, clicks[i], follow);
      if ("error" in r) { setError(`Point ${i + 1}: ${r.error} The route was cut back to point ${i}.`); break; }
      legs.push({ points: r.points, follow });
      if (i === 1) wps[0] = { pos: r.start, exact: follow };
      from = { pos: r.end, exact: follow };
      wps.push(from);
    }
    setDrawLegs(legs); setDrawWaypoints(wps); setDrawClicks(clicks.slice(0, wps.length));
    drawBusyRef.current = false; setDrawBusy(false);
  }

  function undoDraw() {
    if (drawBusyRef.current) return;
    setDrawLegs(l => l.slice(0, -1));
    setDrawWaypoints(w => w.slice(0, -1));
    setDrawClicks(c => c.slice(0, -1));
    setError(null);
  }

  function clearDraw() {
    if (drawBusyRef.current) return;
    setDrawLegs([]); setDrawWaypoints([]); setDrawClicks([]);
    setError(null);
  }

  // The drawn legs, joined up, are the route on the map — so the workout overlay, arrow, save, GPX, Garmin and
  // reverse all work on it like any other.
  useEffect(() => {
    if (sourceMode !== "draw") return;
    setJustSaved(new Set());
    if (drawLegs.length === 0) { setRoutes(null); return; }
    const points = drawLegs.flatMap(l => l.points);
    const cum = cumulativeMi(points);
    setRoutes([{
      points, distanceMi: cum[cum.length - 1], overlapPct: 0, familiarPct: -1, compactness: 1, isLoop: false,
      source: drawLegs.every(l => l.follow) ? "runs" : "streets", snapped: false,
    }]);
    setSelected(0);
  }, [drawLegs, sourceMode]);

  // Numbered markers on the drawn route's points (green start, red latest).
  useEffect(() => {
    if (!mapReady) return;
    let cancelled = false;
    (async () => {
      const L = await import("leaflet");
      const map = mapRef.current;
      if (cancelled || !map) return;
      drawMarkersRef.current.forEach(m => m.remove());
      drawMarkersRef.current = [];
      if (sourceMode !== "draw") return;
      // Small dots in the route's colour — or, with a workout laid over it, the colour of the step each one is on.
      let mi = 0;
      drawWaypoints.forEach((w, i) => {
        if (i > 0) { const c = cumulativeMi(drawLegs[i - 1]?.points ?? []); mi += c[c.length - 1] ?? 0; }
        const seg = timeline?.segs.find(sg => sg.kind !== "rest" && mi >= sg.startMi && mi <= sg.endMi);
        const color = seg ? paceColor(seg.kind, seg.paceSec) : COLORS[0];
        drawMarkersRef.current.push(
          L.circleMarker(w.pos, { radius: 4, color: "#0f172a", weight: 1, fillColor: color, fillOpacity: 1, interactive: false }).addTo(map),
        );
      });
    })();
    return () => { cancelled = true; };
  }, [mapReady, sourceMode, drawWaypoints, drawLegs, timeline]);

  useEffect(() => () => { drawMarkersRef.current.forEach(m => m.remove()); }, []);

  // "03.50 - 11-11-26 - Taper Two Miler": distance, the chosen workout's date and its name (today's date and
  // "Route"/"Loop" when no workout is picked).
  function routeName(c: Candidate): string {
    const w = workouts.find(x => x.uid === planUid);
    const d = w ? new Date(`${w.date}T12:00:00`) : new Date();
    const date = `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getFullYear() % 100).padStart(2, "0")}`;
    return `${c.distanceMi.toFixed(2).padStart(5, "0")} - ${date} - ${w ? w.title : c.isLoop ? "Loop" : "Route"}`;
  }

  // Saved home → opening location and default start.
  useEffect(() => {
    fetch("/api/settings/route-home")
      .then(r => r.json())
      .then((d: { home?: { lat: number; lng: number } | null }) => {
        if (d.home) {
          const h: LatLng = [d.home.lat, d.home.lng];
          setHome(h);
          setStart(s => s ?? h);
        }
      })
      .catch(() => {})
      .finally(() => setHomeLoaded(true));
  }, []);

  // Arrived from a scheduled run's "Create route": search once the home start is known.
  useEffect(() => {
    if (!autoSearch || autoRanRef.current || !homeLoaded) return;
    autoRanRef.current = true;
    void suggest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSearch, homeLoaded]);

  useEffect(() => {
    fetch("/api/settings/route-ors-key")
      .then(r => r.json())
      .then((d: { hasKey?: boolean }) => setOrsHasKey(!!d.hasKey))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/settings/route-excluded")
      .then(r => r.json())
      .then((d: { activities?: RunActivity[]; excluded?: string[] }) => {
        setActivities(d.activities ?? []);
        const ex = new Set((d.excluded ?? []).map(String));
        setSavedExcluded(ex);
        setDraftExcluded(new Set(ex));
      })
      .catch(() => {});
  }, []);

  const needle = filter.trim().toLowerCase();
  // "Excluded only" lists the saved exclusions plus anything ticked since, and
  // keeps just-unticked rows visible until Apply so a slip is easy to undo.
  const matches = activities.filter(a => {
    const id = String(a.id);
    if (onlyExcluded && !savedExcluded.has(id) && !draftExcluded.has(id)) return false;
    const walk = (a.sport ?? "").includes("walking");
    if (walk ? !useWalks : !useRuns) return false;
    return !needle || `${a.name ?? ""} ${a.startTime ?? ""}`.toLowerCase().includes(needle);
  });
  const shown = matches.slice(0, 150);
  const excludeDirty =
    draftExcluded.size !== savedExcluded.size || Array.from(draftExcluded).some(id => !savedExcluded.has(id));

  function toggleExcluded(id: string, on: boolean) {
    setDraftExcluded(prev => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  }

  function setMatches(on: boolean) {
    setDraftExcluded(prev => {
      const next = new Set(prev);
      matches.forEach(a => { if (on) next.add(String(a.id)); else next.delete(String(a.id)); });
      return next;
    });
  }

  async function openSection(pt: LatLng) {
    if (sourceModeRef.current === "streets") return; // exclusions only apply to the GPS-built routes
    setSection({ pt, loading: true, acts: [] });
    try {
      const res = await fetch(`/api/garmin/route-through?lat=${pt[0]}&lng=${pt[1]}&kinds=${kinds}`);
      const d = await res.json() as { activities?: RunActivity[]; error?: string };
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setSection({ pt, loading: false, acts: d.activities ?? [] });
    } catch (e) {
      setSection({ pt, loading: false, acts: [], error: e instanceof Error ? e.message : String(e) });
    }
  }
  const openSectionRef = useRef(openSection);
  openSectionRef.current = openSection;

  function setSectionExcluded(on: boolean) {
    setDraftExcluded(prev => {
      const next = new Set(prev);
      section?.acts.forEach(a => { if (on) next.add(String(a.id)); else next.delete(String(a.id)); });
      return next;
    });
  }

  async function applyExcluded() {
    setExcludeSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/route-excluded", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(draftExcluded) }),
      });
      if (!res.ok) throw new Error("Couldn't save exclusions");
      setSavedExcluded(new Set(draftExcluded));
      setRoutes(null); // the path graph changes, so old suggestions are stale
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExcludeSaving(false);
    }
  }

  async function suggest() {
    const mi = parseFloat(distance);
    if (!mi || mi < 1 || mi > 30) { setError("Enter a distance between 1 and 30 miles"); return; }
    setLoading(true);
    setError(null);
    try {
      const streets = sourceMode === "streets";
      const from = start ?? (streets ? home : null);
      if (streets && !from) { setError("Set a start point first (📍 Set start, or save a home)"); setLoading(false); return; }
      const q = new URLSearchParams({ distanceMi: String(mi), seed: String(Math.floor(Math.random() * 1e9)) });
      if (!streets) { q.set("minRuns", minRuns); q.set("kinds", kinds); if (snap) q.set("snap", "1"); }
      if (avoidLights) q.set("avoidLights", "1");
      if (preferParks) q.set("preferParks", "1");
      if (from) { q.set("lat", String(from[0])); q.set("lng", String(from[1])); }
      if (end) { q.set("endLat", String(end[0])); q.set("endLng", String(end[1])); }
      if (via.length > 0) q.set("via", via.map(v => `${v[0]},${v[1]}`).join("|"));
      const res = await fetch(`/api/garmin/${streets ? "route-explore" : "route-suggestions"}?${q}`);
      const d = await res.json() as { routes?: Candidate[]; runs?: number; start?: LatLng; note?: string; error?: string };
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setNote(d.note ?? null);
      setRoutes(d.routes ?? []);
      setJustSaved(new Set());
      setSavedMsg(null);
      setRuns(d.runs ?? null);
      setSelected(0);
      if (!start && d.start) setStart(d.start);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  function downloadFile(filename: string, text: string) {
    const blob = new Blob([text], { type: "application/gpx+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function exportSaved(r: SavedRoute) {
    try {
      const res = await fetch(`/api/garmin/route/${encodeURIComponent(`saved:${r.id}`)}`);
      const d = await res.json() as { points?: number[][]; error?: string };
      if (!res.ok || !d.points) throw new Error(d.error ?? `HTTP ${res.status}`);
      const points = d.points.map(p => [p[0], p[1]] as LatLng);
      downloadFile(`${r.name.replace(/[^\w.-]+/g, "-")}.gpx`, toGpx({ points } as Candidate, r.name));
    } catch (e) {
      setSavedMsg(e instanceof Error ? e.message : "Couldn't export the route");
    }
  }

  // Uploads a route to Garmin Connect as a course (it then syncs to the watch).
  async function sendToGarmin(name: string, points: LatLng[]) {
    setSavedMsg(`Sending "${name}" to Garmin…`);
    try {
      const res = await fetch("/api/garmin/send-course", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, points }),
      });
      const d = await res.json() as { courseId?: number; error?: string };
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setSavedMsg(`"${name}" is in your Garmin courses — sync your watch to get it.`);
    } catch (e) {
      setSavedMsg(e instanceof Error ? e.message : "Couldn't send the route to Garmin");
    }
  }

  async function sendSavedToGarmin(r: SavedRoute) {
    try {
      const res = await fetch(`/api/garmin/route/${encodeURIComponent(`saved:${r.id}`)}`);
      const d = await res.json() as { points?: number[][]; error?: string };
      if (!res.ok || !d.points) throw new Error(d.error ?? `HTTP ${res.status}`);
      await sendToGarmin(r.name, d.points.map(p => [p[0], p[1]] as LatLng));
    } catch (e) {
      setSavedMsg(e instanceof Error ? e.message : "Couldn't read the route");
    }
  }

  async function importGpx(files: FileList | null) {
    if (!files || files.length === 0) return;
    setSavedMsg(null);
    let imported = 0;
    const problems: string[] = [];
    for (const file of Array.from(files).slice(0, 10)) {
      try {
        if (file.size > 8 * 1024 * 1024) throw new Error("file is over 8 MB");
        const parsed = parseGpx(await file.text(), file.name.replace(/\.gpx$/i, ""));
        if (parsed.length === 0) throw new Error("no track or route found");
        for (const t of parsed.slice(0, 20)) {
          let miles = 0;
          for (let i = 1; i < t.points.length; i++) miles += segMi(t.points[i - 1], t.points[i]);
          if (miles < 0.1) { problems.push(`${t.name}: too short`); continue; }
          const res = await fetch("/api/garmin/saved-routes", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: t.name, distanceMi: miles, points: thinPoints(t.points, 2000), source: "gpx", snapped: false,
              isLoop: segMi(t.points[0], t.points[t.points.length - 1]) < 0.1,
            }),
          });
          if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? `HTTP ${res.status}`);
          imported++;
        }
      } catch (e) {
        problems.push(`${file.name}: ${e instanceof Error ? e.message : "couldn't import"}`);
      }
    }
    loadSaved();
    setSavedMsg(`Imported ${imported} route${imported === 1 ? "" : "s"}.${problems.length ? ` Skipped — ${problems.join("; ")}.` : ""}`);
  }

  function loadSaved() {
    fetch("/api/garmin/saved-routes")
      .then(r => r.json())
      .then((d: { routes?: SavedRoute[] }) => setSaved(d.routes ?? []))
      .catch(() => {});
  }
  useEffect(loadSaved, []);

  async function saveRoute(i: number) {
    const c = routes?.[i];
    if (!c) return;
    const base = routeName(c);
    const name = window.prompt("Name this route", base);
    if (name === null) return;
    setSavedMsg(null);
    try {
      const res = await fetch("/api/garmin/saved-routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || base, distanceMi: c.distanceMi, points: c.points,
          source: c.source ?? (sourceMode === "streets" ? "streets" : "runs"), snapped: !!c.snapped, isLoop: c.isLoop,
        }),
      });
      const d = await res.json() as { error?: string };
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setJustSaved(s => new Set(s).add(i));
      setSavedMsg("Saved. Pin it to a scheduled run from the Runna schedule on the dashboard.");
      loadSaved();
    } catch (e) {
      setSavedMsg(e instanceof Error ? e.message : "Couldn't save the route");
    }
  }

  async function showSaved(r: SavedRoute) {
    try {
      const res = await fetch(`/api/garmin/route/${encodeURIComponent(`saved:${r.id}`)}`);
      const d = await res.json() as { points?: number[][]; error?: string };
      if (!res.ok || !d.points) throw new Error(d.error ?? `HTTP ${res.status}`);
      setRoutes([{
        points: d.points.map(p => [p[0], p[1]] as [number, number]),
        distanceMi: r.distanceMi, overlapPct: 0, familiarPct: -1, compactness: 1,
        isLoop: r.isLoop, source: r.source, snapped: r.snapped,
      }]);
      setSelected(0);
      setNote(`Showing saved route "${r.name}".`);
      setJustSaved(new Set());
    } catch (e) {
      setSavedMsg(e instanceof Error ? e.message : "Couldn't load the route");
    }
  }

  async function renameSaved(r: SavedRoute) {
    const name = window.prompt("Rename route", r.name);
    if (!name || !name.trim()) return;
    await fetch("/api/garmin/saved-routes", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: r.id, name }),
    }).catch(() => {});
    loadSaved();
  }

  async function deleteSaved(r: SavedRoute) {
    if (!window.confirm(`Delete "${r.name}"? If it is pinned to a scheduled run, that pin will stop working.`)) return;
    await fetch("/api/garmin/saved-routes", {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: r.id }),
    }).catch(() => {});
    loadSaved();
  }

  // Start fresh: drop the routes, waypoints, end, filter point and messages,
  // and put the start back at home. Settings (distance, mode, toggles, the
  // exclusion list) are kept.
  function clearAll() {
    setRoutes(null);
    setSelected(0);
    setNote(null);
    setError(null);
    setRuns(null);
    setVia([]);
    setEnd(null);
    setStart(home);
    setMode(null);
    setSection(null);
    setJustSaved(new Set());
    setSavedMsg(null);
    setPlaying(false);
    if (home) mapRef.current?.setView(home, 14);
  }

  async function saveHome() {
    if (!start) return;
    setHomeMsg(null);
    try {
      const res = await fetch("/api/settings/route-home", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat: start[0], lng: start[1] }),
      });
      if (!res.ok) throw new Error();
      setHome(start);
      setHomeMsg("Saved as home");
    } catch {
      setHomeMsg("Couldn't save home");
    }
  }

  // Create the map once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = await import("leaflet");
      if (cancelled || !mapDivRef.current || mapRef.current) return;
      const map = L.map(mapDivRef.current, { zoomControl: true });
      const street = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      });
      const satellite = L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        { maxZoom: 19, attribution: "Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics" },
      );
      street.addTo(map);
      tilesRef.current = { street, satellite };
      map.setView([51.5, -0.1], 12);
      map.on("click", (e: import("leaflet").LeafletMouseEvent) => {
        const p: LatLng = [e.latlng.lat, e.latlng.lng];
        if (sourceModeRef.current === "draw") { addDrawPointRef.current(p); return; }
        if (modeRef.current === "via") { setVia(v => [...v, p]); return; } // stays on to add more
        if (modeRef.current === "start") setStart(p);
        else if (modeRef.current === "end") setEnd(p);
        else return;
        setMode(null);
      });
      const clearHover = () => {
        if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
        hoverSeqRef.current++;
        hoverCircleRef.current?.remove();
        hoverCircleRef.current = null;
        setHover(null);
      };
      map.on("mousemove", (e: import("leaflet").LeafletMouseEvent) => {
        if (modeRef.current !== "via") return;
        if (!hoverCircleRef.current) {
          hoverCircleRef.current = L.circle(e.latlng, {
            radius: WAYPOINT_RADIUS_M, color: "#2563eb", weight: 1, fillColor: "#3b82f6", fillOpacity: 0.15, interactive: false,
          }).addTo(map);
        } else {
          hoverCircleRef.current.setLatLng(e.latlng);
        }
        const seq = ++hoverSeqRef.current;
        const x = e.containerPoint.x, y = e.containerPoint.y;
        setHover(h => (h ? { ...h, x, y } : { x, y, text: "…" }));
        if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = setTimeout(async () => {
          try {
            const res = await fetch(`/api/garmin/route-point?lat=${e.latlng.lat}&lng=${e.latlng.lng}&radius=${WAYPOINT_RADIUS_M}&kinds=${kindsRef.current}`);
            const d = await res.json() as { runs?: number; total?: number; error?: string };
            if (seq !== hoverSeqRef.current) return;
            setHover({ x, y, text: d.error || d.runs === undefined ? "…" : `${d.runs} of ${d.total} runs pass within ${WAYPOINT_RADIUS_M} m` });
          } catch { /* leave the last text */ }
        }, 250);
      });
      map.on("mouseout", clearHover);
      mapRef.current = map;
      setMapReady(true);
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => () => { mapRef.current?.remove(); mapRef.current = null; }, []);

  // Crosshair while picking. Set on the element directly: Leaflet owns this
  // div's className, so React must never re-render it.
  useEffect(() => {
    const el = mapRef.current?.getContainer();
    if (el) el.style.cursor = mode || sourceMode === "draw" ? "crosshair" : "";
  }, [mode, mapReady, sourceMode]);

  // Leaving waypoint mode drops the cursor circle and tooltip.
  useEffect(() => {
    if (mode === "via") return;
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverSeqRef.current++;
    hoverCircleRef.current?.remove();
    hoverCircleRef.current = null;
    setHover(null);
  }, [mode]);

  // Street / satellite.
  useEffect(() => {
    const map = mapRef.current, tiles = tilesRef.current;
    if (!mapReady || !map || !tiles) return;
    const [on, off] = view === "satellite" ? [tiles.satellite, tiles.street] : [tiles.street, tiles.satellite];
    if (map.hasLayer(off)) map.removeLayer(off);
    if (!map.hasLayer(on)) on.addTo(map);
  }, [view, mapReady]);

  // Open on home (or the first start we learn about).
  useEffect(() => {
    if (!mapReady || centredRef.current || !start) return;
    mapRef.current?.setView(start, 14);
    centredRef.current = true;
  }, [mapReady, start]);

  // Start / end / home markers.
  useEffect(() => {
    if (!mapReady) return;
    let cancelled = false;
    (async () => {
      const L = await import("leaflet");
      const map = mapRef.current;
      if (cancelled || !map) return;
      markersRef.current.forEach(m => m.remove());
      markersRef.current = [];
      if (sourceModeRef.current === "draw") return;
      const pin = (p: LatLng, label: string, bg: string) => {
        const icon = L.divIcon({
          className: "",
          iconSize: [26, 26],
          iconAnchor: [13, 13],
          html: `<div style="width:26px;height:26px;border-radius:50%;background:${bg};color:#fff;font:700 13px/26px sans-serif;text-align:center;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5)">${label}</div>`,
        });
        markersRef.current.push(L.marker(p, { icon, interactive: false }).addTo(map));
      };
      if (home && (!start || home[0] !== start[0] || home[1] !== start[1])) pin(home, "🏠", "#475569");
      if (start) pin(start, "S", "#16a34a");
      if (end) pin(end, "E", "#dc2626");
      // Numbered waypoints; click one to remove it.
      via.forEach((p, i) => {
        markersRef.current.push(
          L.circle(p, { radius: WAYPOINT_RADIUS_M, color: "#2563eb", weight: 1, fillColor: "#3b82f6", fillOpacity: 0.12, interactive: false }).addTo(map),
        );
        const icon = L.divIcon({
          className: "",
          iconSize: [24, 24],
          iconAnchor: [12, 12],
          html: `<div style="width:24px;height:24px;border-radius:50%;background:#2563eb;color:#fff;font:700 12px/20px sans-serif;text-align:center;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5)">${i + 1}</div>`,
        });
        markersRef.current.push(
          L.marker(p, { icon })
            .on("click", () => setVia(v => v.filter((_, j) => j !== i)))
            .bindTooltip(`Waypoint ${i + 1} — click to remove`)
            .addTo(map),
        );
      });
      if (section) {
        markersRef.current.push(
          L.circleMarker(section.pt, { radius: 9, color: "#fff", weight: 2, fillColor: "#f59e0b", fillOpacity: 0.9 })
            .on("click", (e: import("leaflet").LeafletMouseEvent) => { L.DomEvent.stopPropagation(e); setSection(null); })
            .bindTooltip("Click to remove this filter point")
            .addTo(map),
        );
      }
    })();
    return () => { cancelled = true; };
  }, [mapReady, home, start, end, via, section?.pt, sourceMode]);

  // Draw every candidate faintly and the selected one bold.
  useEffect(() => {
    if (!mapReady) return;
    let cancelled = false;
    (async () => {
      const L = await import("leaflet");
      const map = mapRef.current;
      if (cancelled || !map) return;
      layersRef.current.forEach(l => l.remove());
      layersRef.current = [];
      if (!routes || routes.length === 0) return;
      routes.forEach((r, i) => {
        if (i === selected) return;
        const layer = L.polyline(r.points, { color: COLORS[i % COLORS.length], weight: 3, opacity: 0.45 }).addTo(map);
        layer.on("click", (e: import("leaflet").LeafletMouseEvent) => {
          setSelected(i);
          openSectionRef.current([e.latlng.lat, e.latlng.lng]);
        });
        layersRef.current.push(layer);
      });
      const sel = routes[selected];
      if (sel) {
        const layer = L.polyline(sel.points, { color: COLORS[selected % COLORS.length], weight: 5, opacity: 0.95 }).addTo(map);
        layer.on("click", (e: import("leaflet").LeafletMouseEvent) => openSectionRef.current([e.latlng.lat, e.latlng.lng]));
        layersRef.current.push(layer);
        // Numbered badge at each whole mile along the selected route.
        const cum = cumulativeMi(sel.points);
        for (let m = 1; m <= Math.floor(cum[cum.length - 1]); m++) {
          const icon = L.divIcon({
            className: "",
            iconSize: [20, 20],
            iconAnchor: [10, 10],
            html: `<div style="width:20px;height:20px;border-radius:50%;background:#0f172a;color:#fff;font:700 11px/16px sans-serif;text-align:center;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.5)">${m}</div>`,
          });
          layersRef.current.push(L.marker(pointAt(sel.points, cum, m).pos, { icon, interactive: false }).addTo(map));
        }
        if (sourceModeRef.current !== "draw") map.fitBounds(layer.getBounds(), { padding: [30, 30] });
      }
    })();
    return () => { cancelled = true; };
  }, [mapReady, routes, selected]);

  // The chosen workout's steps drawn over the selected route, coloured by pace, with a numbered badge where
  // each step starts and a pause marker at each rest.
  useEffect(() => {
    if (!mapReady) return;
    let cancelled = false;
    (async () => {
      const L = await import("leaflet");
      const map = mapRef.current;
      if (cancelled || !map) return;
      planLayersRef.current.forEach(l => l.remove());
      planLayersRef.current = [];
      const pts = selectedRoute?.points;
      if (!timeline || !pts || pts.length < 2) return;
      const cum = cumulativeMi(pts);
      const slice = (a: number, b: number): LatLng[] => {
        const out: LatLng[] = [pointAt(pts, cum, a).pos];
        for (let i = 0; i < pts.length; i++) if (cum[i] > a && cum[i] < b) out.push(pts[i]);
        out.push(pointAt(pts, cum, b).pos);
        return out;
      };
      timeline.segs.forEach((seg, i) => {
        const color = paceColor(seg.kind, seg.paceSec);
        const text = seg.kind === "rest"
          ? `${seg.label} (${fmtClock(seg.endSec - seg.startSec)})`
          : `${seg.label} — ${(seg.endMi - seg.startMi).toFixed(2)} mi${seg.paceSec ? ` at ${fmtPace(seg.paceSec)}${seg.assumedPace ? " (assumed)" : ""}` : ""}`;
        if (seg.kind !== "rest") {
          const line = L.polyline(slice(seg.startMi, seg.endMi), { color, weight: 8, opacity: 0.95, dashArray: seg.kind === "beyond" ? "2 8" : undefined })
            .bindTooltip(text, { sticky: true }).addTo(map);
          planLayersRef.current.push(line);
        }
        const at = pointAt(pts, cum, seg.startMi).pos;
        const icon = L.divIcon({
          className: "", iconSize: [18, 18], iconAnchor: [9, 9],
          html: `<div style="width:18px;height:18px;border-radius:${seg.kind === "rest" ? "3px" : "50%"};background:${color};color:#0f172a;font:700 10px/14px sans-serif;text-align:center;border:2px solid #0f172a;box-shadow:0 1px 3px rgba(0,0,0,.6)">${seg.kind === "rest" ? "⏸" : i + 1}</div>`,
        });
        planLayersRef.current.push(L.marker(at, { icon, zIndexOffset: 500 }).bindTooltip(text).addTo(map));
      });
    })();
    return () => { cancelled = true; };
  }, [mapReady, routes, selected, timeline]);

  // A different route, workout or new suggestions resets the arrow.
  useEffect(() => {
    setPlaying(false);
    setPlayMi(0);
    setPlaySec(0);
    playMiRef.current = 0;
    playSecRef.current = 0;
    arrowRef.current?.remove();
    arrowRef.current = null;
  }, [routes, selected, planUid]);

  useEffect(() => {
    if (!playing) return;
    const pts = routes?.[selected]?.points;
    if (!pts || pts.length < 2 || !mapRef.current) { setPlaying(false); return; }
    let cancelled = false;
    let raf = 0;
    (async () => {
      const L = await import("leaflet");
      const map = mapRef.current;
      if (cancelled || !map) return;
      const cum = cumulativeMi(pts);
      const total = cum[cum.length - 1];
      // With a workout the arrow runs on its clock (each step at its own pace, paused through rests, sped up
      // by playSpeed); without one it moves at a steady PLAY_MI_PER_SEC.
      const endSec = timeline ? timeline.totalSec : total / PLAY_MI_PER_SEC;
      if (playSecRef.current >= endSec) { playSecRef.current = 0; playMiRef.current = 0; }
      const rate = timeline ? playSpeed : 1;
      const miAt = (sec: number) => timeline ? positionAt(timeline, sec).mi : Math.min(total, sec * PLAY_MI_PER_SEC);
      if (!arrowRef.current) {
        const icon = L.divIcon({ className: "", html: ARROW_HTML, iconSize: [26, 26], iconAnchor: [13, 13] });
        arrowRef.current = L.marker(pointAt(pts, cum, miAt(playSecRef.current)).pos, { icon, interactive: false, zIndexOffset: 1000 }).addTo(map);
      }
      const t0 = performance.now() - (playSecRef.current / rate) * 1000;
      let lastUi = 0;
      const frame = (now: number) => {
        if (cancelled) return;
        const sec = Math.min(endSec, ((now - t0) / 1000) * rate);
        const mi = miAt(sec);
        playSecRef.current = sec;
        playMiRef.current = mi;
        const { pos, bearing } = pointAt(pts, cum, mi);
        const marker = arrowRef.current;
        if (marker) {
          marker.setLatLng(pos);
          const inner = marker.getElement()?.firstElementChild as HTMLElement | null | undefined;
          if (inner) inner.style.transform = `rotate(${bearing}deg)`;
          if (!map.getBounds().contains(pos)) map.panTo(pos, { animate: false });
        }
        if (now - lastUi > 100 || sec >= endSec) { lastUi = now; setPlayMi(mi); setPlaySec(sec); }
        if (sec >= endSec) { setPlaying(false); return; }
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
    })();
    return () => { cancelled = true; cancelAnimationFrame(raf); };
  }, [playing, routes, selected, timeline, playSpeed]);

  useEffect(() => () => { arrowRef.current?.remove(); arrowRef.current = null; planLayersRef.current.forEach(l => l.remove()); }, []);

  // Runs route `i` the other way round (the GPX, Garmin course, workout overlay and arrow all follow).
  function reverseRoute(i: number) {
    setRoutes(rs => rs && rs.map((r, k) => k === i ? { ...r, points: [...r.points].reverse() } : r));
  }

  function downloadGpx(i: number) {
    const c = routes?.[i];
    if (!c) return;
    const name = routeName(c);
    const blob = new Blob([toGpx(c, name)], { type: "application/gpx+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name.replace(/\s+/g, "-")}.gpx`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const chip = "rounded-lg border px-2.5 py-1 text-xs transition-colors";
  const chipIdle = "border-white/10 bg-slate-800 text-slate-300 hover:bg-slate-700";
  const chipOn = "border-green-500/60 bg-green-600/20 text-green-300";

  return (
    <div className="relative isolate min-h-screen flex flex-col text-slate-100">
      <div aria-hidden className="fixed inset-0 -z-10 bg-slate-950 pointer-events-none" />
      <TopNav title="🗺️ Route Finder" maxWidth="max-w-[1800px]" />

      <div className="flex-1 max-w-[1800px] w-full mx-auto px-4 py-6 grid gap-6 lg:grid-cols-[22rem_1fr]">
        <div className="space-y-4">
          <div className="rounded-xl bg-slate-900/70 border border-white/10 p-4 space-y-3">
            <div className="flex rounded-lg overflow-hidden border border-white/10 text-xs">
              {([["runs", "From activities"], ["streets", "New streets"], ["draw", "Draw route"]] as const).map(([m, label]) => (
                <button
                  key={m}
                  onClick={() => { setSourceMode(m); setRoutes(null); setNote(null); setError(null); }}
                  className={`flex-1 px-3 py-1.5 ${sourceMode === m ? "bg-green-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="text-xs text-slate-400">
              {sourceMode === "runs"
                ? "New routes of the distance you pick, joined up from roads and paths you've already run or walked."
                : sourceMode === "streets"
                ? "Brand-new routes of the distance you pick on real streets, from your start (and end) point — not based on your runs."
                : "Click points on the map and the route is drawn from one to the next."}
            </p>
            {sourceMode !== "streets" && (
              <div className="flex items-center gap-4 text-xs text-slate-300">
                <span className="text-slate-500">Use:</span>
                {([["Runs", useRuns, useWalks, setUseRuns], ["Walks", useWalks, useRuns, setUseWalks]] as const).map(([label, on, other, set]) => (
                  <label key={label} className="flex items-center gap-1.5 cursor-pointer">
                    <input type="checkbox" checked={on} disabled={on && !other} title={on && !other ? "Keep at least one ticked" : undefined}
                      onChange={e => {
                        set(e.target.checked);
                        setRoutes(null); setNote(null); setRuns(null);
                        if (sourceMode === "draw") { clearDraw(); }
                      }} />
                    {label}
                  </label>
                ))}
              </div>
            )}
            {sourceMode === "draw" ? (
              <div className="space-y-2">
                <p className="text-2xl font-semibold tabular-nums text-green-300">
                  {(routes?.[0]?.distanceMi ?? 0).toFixed(2)} <span className="text-sm font-normal text-slate-400">miles</span>
                  {drawBusy && <span className="ml-2 text-xs font-normal text-slate-400">routing…</span>}
                </p>
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <input type="checkbox" checked={drawFollow} disabled={drawBusy} onChange={e => { setDrawFollow(e.target.checked); void rerouteDraw(e.target.checked); }} />
                  Follow my routes <span className="text-slate-500">— only along paths I&apos;ve already run</span>
                </label>
                {drawFollow && (
                  <label className="flex items-center gap-2 text-xs text-slate-400">
                    Paths run at least
                    <input
                      type="number" min={1} max={50} step={1} value={minRuns}
                      onChange={e => setMinRuns(e.target.value)}
                      className="w-16 rounded-lg bg-slate-800 border border-white/10 px-2 py-1 text-xs text-slate-200"
                    />
                    <span>or more times</span>
                  </label>
                )}
                {!drawFollow && orsHasKey === false && (
                  <p className="text-[11px] text-amber-300">
                    Street routing needs an OpenRouteService key — add one in <Link href="/settings" className="underline">Settings → Integrations</Link>.
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  {home && drawWaypoints.length === 0 && (
                    <button
                      onClick={() => { void addDrawPoint(home); mapRef.current?.setView(home, Math.max(mapRef.current.getZoom(), 15)); }}
                      className={`${chip} ${chipIdle}`}
                    >
                      🏠 Start from home
                    </button>
                  )}
                  <button onClick={undoDraw} disabled={drawBusy || drawWaypoints.length === 0} className={`${chip} ${chipIdle} disabled:opacity-40`}>↶ Undo last point</button>
                  <button
                    onClick={clearDraw} disabled={drawBusy || drawWaypoints.length === 0}
                    className="rounded-lg border border-red-500/30 bg-red-500/10 text-red-300 hover:bg-red-500/20 disabled:opacity-40 px-2.5 py-1 text-xs transition-colors"
                  >
                    ↺ Clear route
                  </button>
                </div>
                <p className="text-[11px] text-slate-500">
                  {drawWaypoints.length === 0
                    ? "Click the map to place the start, then keep clicking to add points."
                    : `${drawWaypoints.length} point${drawWaypoints.length === 1 ? "" : "s"} — click the map to carry on. ${drawFollow ? "Each point snaps to the nearest path you've run." : "Each stretch follows real streets (sent to openrouteservice.org)."}`}
                </p>
              </div>
            ) : (<>
            <div className="flex items-center gap-2">
              <input
                type="number" min={1} max={30} step={0.1} value={distance}
                onChange={e => setDistance(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") suggest(); }}
                className="w-24 rounded-lg bg-slate-800 border border-white/10 px-3 py-1.5 text-sm"
              />
              <span className="text-sm text-slate-400">miles</span>
              <button
                onClick={suggest} disabled={loading}
                className="ml-auto rounded-lg bg-green-600 hover:bg-green-500 disabled:opacity-50 px-4 py-1.5 text-sm font-medium"
              >
                {loading ? "Searching…" : routes ? "More" : "Suggest"}
              </button>
            </div>

            <div className="space-y-1 text-xs text-slate-300">
              {sourceMode === "runs" && (
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={snap} onChange={e => setSnap(e.target.checked)} />
                  Snap routes to real streets
                </label>
              )}
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={avoidLights} onChange={e => setAvoidLights(e.target.checked)} />
                Avoid traffic lights
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={preferParks} onChange={e => setPreferParks(e.target.checked)} />
                Prefer parks
              </label>
              {(sourceMode === "streets" || snap) && orsHasKey === false && (
                <p className="text-[11px] text-amber-300">
                  Street routing needs an OpenRouteService key — add one in <Link href="/settings" className="underline">Settings → Integrations</Link>.
                </p>
              )}
              {(sourceMode === "streets" || snap || avoidLights || preferParks) && (
                <p className="text-[11px] text-slate-500">
                  {sourceMode === "streets" || snap ? "Start, end and waypoints are sent to openrouteservice.org. " : ""}
                  {avoidLights || preferParks ? "Traffic lights and parks come from OpenStreetMap (overpass-api.de), which is often slow — this can add up to a minute." : ""}
                </p>
              )}
            </div>

            {sourceMode === "runs" && (<>
            <label className="flex items-center gap-2 text-xs text-slate-400">
              Only use paths you&apos;ve run at least
              <input
                type="number" min={1} max={50} step={1} value={minRuns}
                onChange={e => setMinRuns(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") suggest(); }}
                className="w-16 rounded-lg bg-slate-800 border border-white/10 px-2 py-1 text-xs text-slate-200"
              />
              <span>or more times</span>
            </label>

            </>)}

            <div className="space-y-2 pt-1 border-t border-white/5">
              <div className="flex flex-wrap gap-2">
                <button onClick={() => setMode(mode === "start" ? null : "start")} className={`${chip} ${mode === "start" ? chipOn : chipIdle}`}>
                  📍 {start ? "Move start" : "Set start"}
                </button>
                <button onClick={() => setMode(mode === "end" ? null : "end")} className={`${chip} ${mode === "end" ? chipOn : chipIdle}`}>
                  🏁 {end ? "Move end" : "Set end"}
                </button>
                {end && <button onClick={() => setEnd(null)} className={`${chip} ${chipIdle}`}>✕ Clear end</button>}
                <button onClick={() => setMode(mode === "via" ? null : "via")} className={`${chip} ${mode === "via" ? chipOn : chipIdle}`}>
                  📌 {mode === "via" ? "Done adding" : "Add waypoints"}
                </button>
                {via.length > 0 && <button onClick={() => setVia([])} className={`${chip} ${chipIdle}`}>✕ Clear waypoints ({via.length})</button>}
                {home && <button onClick={() => setStart(home)} className={`${chip} ${chipIdle}`}>🏠 Start at home</button>}
                <button
                  onClick={clearAll}
                  className="rounded-lg border border-red-500/30 bg-red-500/10 text-red-300 hover:bg-red-500/20 px-2.5 py-1 text-xs transition-colors"
                  title="Remove the routes, waypoints and end point, and put the start back at home"
                >
                  ↺ Clear route
                </button>
                {start && (!home || home[0] !== start[0] || home[1] !== start[1]) && (
                  <button onClick={saveHome} className={`${chip} ${chipIdle}`}>Save start as home</button>
                )}
              </div>
              <p className="text-[11px] text-slate-500">
                {mode === "via"
                  ? `Click the map to add waypoints in order. Each is a ${WAYPOINT_RADIUS_M} m circle; the tooltip counts the runs through it. Click a numbered waypoint to remove it.`
                  : mode ? `Click the map to place the ${mode}.`
                  : end ? "Point-to-point from start to end." : "No end set — routes loop back to the start."}
                {via.length > 0 && mode !== "via" && ` Passing through ${via.length} waypoint${via.length === 1 ? "" : "s"} in order.`}
                {!home && start && " Save the start as home so the map opens here."}
                {homeMsg && <span className="text-green-400"> {homeMsg}.</span>}
              </p>
            </div>

            </>)}

            {error && <p className="text-xs text-red-400">{error}</p>}
            {note && <p className="text-xs text-amber-300">{note}</p>}
            {runs !== null && <p className="text-[11px] text-slate-500">Built from {runs} {kinds === "walks" ? "walks" : kinds === "both" ? "runs and walks" : "runs"}.</p>}
          </div>

          {sourceMode === "runs" && section && (
            <div className="rounded-xl bg-slate-900/70 border border-amber-500/30 p-4 space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-amber-300">Activities through this spot</h3>
                <button onClick={() => setSection(null)} className="text-xs text-slate-500 hover:text-slate-300">✕</button>
              </div>
              {section.loading && <p className="text-xs text-slate-400">Searching your runs…</p>}
              {section.error && <p className="text-xs text-red-400">{section.error}</p>}
              {!section.loading && !section.error && (
                <>
                  <p className="text-[11px] text-slate-500">
                    {section.acts.length} run{section.acts.length === 1 ? "" : "s"} pass within 30 m. Tick the ones to leave out of route finding.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button onClick={() => setSectionExcluded(true)} disabled={section.acts.length === 0} className={`${chip} ${chipIdle} disabled:opacity-40`}>Exclude all {section.acts.length}</button>
                    <button onClick={() => setSectionExcluded(false)} disabled={section.acts.length === 0} className={`${chip} ${chipIdle} disabled:opacity-40`}>Include all</button>
                  </div>
                  <div className="max-h-56 overflow-y-auto rounded-lg border border-white/5 divide-y divide-white/5">
                    {section.acts.map(a => {
                      const id = String(a.id);
                      return (
                        <label key={id} className="flex items-center gap-2 px-2 py-1.5 text-xs cursor-pointer hover:bg-slate-800/60">
                          <input type="checkbox" checked={draftExcluded.has(id)} onChange={e => toggleExcluded(id, e.target.checked)} />
                          <span className="flex-1 truncate">{a.name || "Run"}</span>
                          <span className="text-slate-500 whitespace-nowrap">
                            {a.startTime ? a.startTime.slice(0, 10) : ""}{a.distanceMi ? ` · ${a.distanceMi.toFixed(1)}mi` : ""}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  <button
                    onClick={applyExcluded} disabled={!excludeDirty || excludeSaving}
                    className="w-full rounded-lg bg-green-600 hover:bg-green-500 disabled:opacity-40 px-3 py-1.5 text-sm font-medium"
                  >
                    {excludeSaving ? "Saving…" : excludeDirty ? `Apply (${draftExcluded.size} excluded) & clear routes` : "Applied"}
                  </button>
                </>
              )}
            </div>
          )}

          {sourceMode === "runs" && (
          <div className="rounded-xl bg-slate-900/70 border border-white/10">
            <button
              onClick={() => setExcludeOpen(o => !o)}
              className="w-full flex items-center justify-between px-4 py-3 text-sm"
            >
              <span>Exclude activities{savedExcluded.size > 0 && <span className="text-amber-300"> · {savedExcluded.size} excluded</span>}</span>
              <span className="text-slate-500">{excludeOpen ? "▲" : "▼"}</span>
            </button>
            {excludeOpen && (
              <div className="px-4 pb-4 space-y-2 border-t border-white/5 pt-3">
                <p className="text-[11px] text-slate-500">
                  Ticked runs are ignored when learning your paths — e.g. races on roads that are only closed on race day.
                </p>
                <input
                  type="search" value={filter} onChange={e => setFilter(e.target.value)}
                  placeholder="Search by name or date (e.g. marathon, 2025-04)"
                  className="w-full rounded-lg bg-slate-800 border border-white/10 px-3 py-1.5 text-sm"
                />
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <button onClick={() => setOnlyExcluded(o => !o)} className={`${chip} ${onlyExcluded ? chipOn : chipIdle}`}>
                    {onlyExcluded ? "Showing excluded only" : `Show excluded (${draftExcluded.size})`}
                  </button>
                  <button onClick={() => setMatches(true)} disabled={matches.length === 0} className={`${chip} ${chipIdle} disabled:opacity-40`}>
                    Exclude all {matches.length} match{matches.length === 1 ? "" : "es"}
                  </button>
                  <button onClick={() => setMatches(false)} disabled={matches.length === 0} className={`${chip} ${chipIdle} disabled:opacity-40`}>
                    Include all
                  </button>
                </div>
                <div className="max-h-64 overflow-y-auto rounded-lg border border-white/5 divide-y divide-white/5">
                  {shown.map(a => {
                    const id = String(a.id);
                    return (
                      <label key={id} className="flex items-center gap-2 px-2 py-1.5 text-xs cursor-pointer hover:bg-slate-800/60">
                        <input type="checkbox" checked={draftExcluded.has(id)} onChange={e => toggleExcluded(id, e.target.checked)} />
                        <span className="flex-1 truncate">{a.name || "Run"}</span>
                        <span className="text-slate-500 whitespace-nowrap">
                          {a.startTime ? a.startTime.slice(0, 10) : ""}{a.distanceMi ? ` · ${a.distanceMi.toFixed(1)}mi` : ""}
                        </span>
                      </label>
                    );
                  })}
                  {shown.length === 0 && <p className="px-2 py-3 text-xs text-slate-500">{onlyExcluded ? "Nothing is excluded." : "No activities match."}</p>}
                </div>
                {matches.length > shown.length && (
                  <p className="text-[11px] text-slate-500">Showing {shown.length} of {matches.length} — narrow the search to see the rest.</p>
                )}
                <button
                  onClick={applyExcluded} disabled={!excludeDirty || excludeSaving}
                  className="w-full rounded-lg bg-green-600 hover:bg-green-500 disabled:opacity-40 px-3 py-1.5 text-sm font-medium"
                >
                  {excludeSaving ? "Saving…" : excludeDirty ? `Apply (${draftExcluded.size} excluded)` : "Applied"}
                </button>
              </div>
            )}
          </div>

          )}

          <div className="rounded-xl bg-slate-900/70 border border-white/10">
            <button
              onClick={() => setSavedOpen(o => !o)}
              className="w-full flex items-center justify-between px-4 py-3 text-sm"
            >
              <span>Saved routes{saved.length > 0 && <span className="text-green-300"> · {saved.length}</span>}</span>
              <span className="text-slate-500">{savedOpen ? "▲" : "▼"}</span>
            </button>
            {savedOpen && (
              <div className="px-4 pb-4 space-y-2 border-t border-white/5 pt-3">
                <p className="text-[11px] text-slate-500">
                  Saved routes appear on a scheduled Runna run of about the same distance, where you can pin one to it.
                </p>
                <div className="flex items-center gap-2">
                  <label className={`${chip} ${chipIdle} cursor-pointer`}>
                    ⬆ Import GPX
                    <input
                      type="file" accept=".gpx,application/gpx+xml,text/xml" multiple className="hidden"
                      onChange={e => { void importGpx(e.target.files); e.target.value = ""; }}
                    />
                  </label>
                  <span className="text-[11px] text-slate-500">Each track in a file becomes a saved route.</span>
                </div>
                {saved.length === 0 && <p className="text-xs text-slate-500">Nothing saved yet — press 💾 Save on a route, or import a GPX file.</p>}
                <div className="max-h-64 overflow-y-auto rounded-lg border border-white/5 divide-y divide-white/5">
                  {saved.map(r => (
                    <div key={r.id} className="flex items-center gap-2 px-2 py-1.5 text-xs">
                      <button onClick={() => void showSaved(r)} className="flex-1 min-w-0 truncate text-left hover:text-green-300" title="Show on the map">
                        {r.name}
                      </button>
                      <span className="text-slate-500 whitespace-nowrap">{r.distanceMi.toFixed(1)} mi</span>
                      <button onClick={() => void exportSaved(r)} className="text-slate-500 hover:text-slate-200" title="Export as GPX">⬇</button>
                      <button onClick={() => void sendSavedToGarmin(r)} className="text-slate-500 hover:text-slate-200" title="Send to Garmin courses">⌚</button>
                      <button onClick={() => void renameSaved(r)} className="text-slate-500 hover:text-slate-200" title="Rename">✎</button>
                      <button onClick={() => void deleteSaved(r)} className="text-slate-500 hover:text-red-300" title="Delete">✕</button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          {savedMsg && <p className="text-xs text-green-300">{savedMsg}</p>}

          {routes && routes.length === 0 && !loading && (
            <p className="text-sm text-slate-400">
              No route of that length fits your running history from there. Try a nearby distance, or a start/end on ground you&apos;ve run.
            </p>
          )}

          {routes?.map((r, i) => (
            <div
              key={i}
              onClick={() => setSelected(i)}
              className={`cursor-pointer rounded-xl border p-3 transition-colors ${i === selected ? "border-white/40 bg-slate-800/80" : "border-white/10 bg-slate-900/60 hover:bg-slate-800/50"}`}
            >
              <div className="flex items-center gap-2">
                <span className="inline-block w-3 h-3 rounded-full" style={{ background: COLORS[i % COLORS.length] }} />
                <span className="font-semibold text-sm">{r.distanceMi.toFixed(2)} mi</span>
                {r.score !== undefined && (
                  <span className="rounded bg-emerald-700/40 text-emerald-300 text-[11px] px-1.5 py-0.5" title="Distance fit, smoothness, familiarity, lights and parks">Score {r.score}</span>
                )}
                {r.snapped && <span className="text-[10px] text-sky-300">streets</span>}
                <button
                  onClick={e => { e.stopPropagation(); void saveRoute(i); }}
                  disabled={justSaved.has(i)}
                  className="ml-auto text-xs text-slate-400 hover:text-green-300 disabled:text-green-400"
                >
                  {justSaved.has(i) ? "Saved ✓" : "💾 Save"}
                </button>
                <button
                  onClick={e => { e.stopPropagation(); downloadGpx(i); }}
                  className="text-xs text-slate-400 hover:text-slate-200"
                >
                  GPX ⬇
                </button>
                <button
                  onClick={e => { e.stopPropagation(); void sendToGarmin(routeName(r), r.points); }}
                  className="text-xs text-slate-400 hover:text-slate-200"
                  title="Send to Garmin courses"
                >
                  ⌚ Garmin
                </button>
                <button
                  onClick={e => { e.stopPropagation(); reverseRoute(i); }}
                  className="text-xs text-slate-400 hover:text-slate-200"
                  title="Run this route the other way round"
                >
                  ⇄ Reverse
                </button>
              </div>
              <p className="mt-1 text-xs text-slate-400">
                {r.familiarPct >= 0 ? `${r.familiarPct}% on ground you've run · ` : ""}{r.overlapPct}% retraced{r.isLoop ? ` · roundness ${Math.round(r.compactness * 100)}%` : ""}
                {r.lights !== null && r.lights !== undefined ? ` · 🚦 ${r.lights}` : ""}
                {r.parkPct !== null && r.parkPct !== undefined ? ` · 🌳 ${r.parkPct}%` : ""}
              </p>
            </div>
          ))}
        </div>

        <div className="relative self-start lg:sticky lg:top-20">
          <div
            ref={mapDivRef}
            className="rounded-xl overflow-hidden border border-white/10 min-h-[28rem] lg:min-h-[calc(100vh-8rem)]"
          />
          {hover && mode === "via" && (
            <div
              className="pointer-events-none absolute z-[1000] rounded bg-slate-900/95 border border-white/20 px-2 py-1 text-[11px] text-slate-100 shadow whitespace-nowrap"
              style={{ left: hover.x + 14, top: hover.y + 14 }}
            >
              {hover.text}
            </div>
          )}
          {routes && routes[selected] && (
            <div className="absolute bottom-6 left-3 z-[1000] w-[min(24rem,calc(100%-1.5rem))] space-y-1.5 rounded-lg bg-slate-900/90 border border-white/20 px-3 py-2 text-xs shadow">
              {workouts.length > 0 && (
                <label className="flex items-center gap-2 text-slate-300">
                  <span className="shrink-0">Workout</span>
                  <select
                    value={planUid}
                    onChange={e => setPlanUid(e.target.value)}
                    className="min-w-0 flex-1 rounded bg-slate-800 border border-white/10 px-1.5 py-1 text-slate-100"
                  >
                    <option value="">None — plain route</option>
                    {workouts.map(w => (
                      <option key={w.uid} value={w.uid}>
                        {new Date(`${w.date}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} · {w.title}{w.distanceMi ? ` · ${w.distanceMi}mi` : ""}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {planUid && !timeline && <p className="text-amber-300">Couldn&apos;t read any steps from that workout.</p>}
              {timeline && (
                <>
                  <p className="text-[11px] text-slate-400">
                    Workout {timeline.workoutMi.toFixed(1)} mi on a {timeline.routeMi.toFixed(1)} mi route
                    {timeline.workoutMi > timeline.routeMi + 0.05 ? " — the last steps don't fit and are cut off." : timeline.routeMi > timeline.workoutMi + 0.05 ? " — the rest of the route is shown dotted, at the last pace." : "."}
                  </p>
                  <div className="max-h-28 overflow-y-auto rounded border border-white/5 divide-y divide-white/5">
                    {timeline.segs.map((seg, i) => {
                      const cur = positionAt(timeline, playSec).segIndex === i && playSec > 0;
                      return (
                        <div key={i} className={`flex items-center gap-2 px-1.5 py-0.5 ${cur ? "bg-white/10 text-white" : "text-slate-300"}`}>
                          <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: paceColor(seg.kind, seg.paceSec) }} />
                          <span className="min-w-0 flex-1 truncate">{i + 1}. {seg.label}</span>
                          <span className="shrink-0 tabular-nums text-slate-400">
                            {seg.kind === "rest" ? fmtClock(seg.endSec - seg.startSec) : `${(seg.endMi - seg.startMi).toFixed(2)} mi${seg.paceSec ? ` · ${fmtPace(seg.paceSec)}${seg.assumedPace ? "*" : ""}` : ""}`}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  {timeline.segs.some(sg => sg.assumedPace) && <p className="text-[10px] text-slate-500">* no pace in the workout, so an easy pace is assumed.</p>}
                </>
              )}
              <div className="flex items-center gap-3">
                <button onClick={() => setPlaying(p => !p)} className="font-medium text-green-300 hover:text-green-200">
                  {playing ? "⏸ Pause" : "▶ Play"}
                </button>
                <button onClick={() => reverseRoute(selected)} className="text-slate-300 hover:text-white" title="Run this route the other way round">
                  ⇄ Reverse
                </button>
                <span className="text-slate-300 tabular-nums">{playMi.toFixed(1)} / {routes[selected].distanceMi.toFixed(1)} mi</span>
                {timeline && (
                  <>
                    <span className="text-slate-300 tabular-nums">{fmtClock(playSec)} / {fmtClock(timeline.totalSec)}</span>
                    <label className="ml-auto flex items-center gap-1 text-slate-400">
                      Speed
                      <select value={playSpeed} onChange={e => setPlaySpeed(parseInt(e.target.value))} className="rounded bg-slate-800 border border-white/10 px-1 py-0.5 text-slate-100">
                        {[10, 30, 60, 120, 240].map(v => <option key={v} value={v}>{v}×</option>)}
                      </select>
                    </label>
                  </>
                )}
              </div>
            </div>
          )}
          <div className="absolute top-3 right-3 z-[1000] flex rounded-lg overflow-hidden border border-white/20 text-xs shadow">
            {(["street", "satellite"] as const).map(v => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`px-3 py-1.5 ${view === v ? "bg-green-600 text-white" : "bg-slate-900/90 text-slate-300 hover:bg-slate-800"}`}
              >
                {v === "street" ? "Map" : "Satellite"}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
