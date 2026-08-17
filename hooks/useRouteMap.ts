import { useEffect, useRef, useState } from "react";

// Shared GPS-route rendering logic, extracted from components/RouteMapLightbox.tsx
// so the new run-detail full page (app/run/[date]) can reuse the exact same
// Leaflet map/coloring/hover-highlight behavior without duplicating it.
// RouteMapLightbox itself is left untouched (it's also used from
// DashboardClient.tsx) — this hook is additive, used by the new page only.

export type RoutePoint = [number, number, number | null, number | null, number]; // lat, lng, speed mph, elapsed sec, cumulative mi

export interface WorkoutSection {
  label: string;
  kind: "warmup" | "work" | "easy" | "cooldown" | "rest" | "strength";
  startSec: number;
  endSec: number;
  startMi: number;
  endMi: number;
  paceSec: number | null;
}

export interface RouteMapTrack {
  uri: string | null;
  name: string;
  artist: string;
  startsAtSec: number;
  durationSec?: number;
  tempo: number | null;
}

const SEGMENT_COLORS = ["#3b82f6", "#22c55e", "#f97316", "#ef4444"]; // slow -> fast

const SECTION_COLOR_CYCLE = [
  "#ef4444", "#22c55e", "#a855f7", "#f59e0b",
  "#06b6d4", "#ec4899", "#84cc16", "#6366f1",
];

function assignSectionColors(sections: WorkoutSection[]): string[] {
  const colors: string[] = [];
  let cursor = 0;
  for (let i = 0; i < sections.length; i++) {
    let color = SECTION_COLOR_CYCLE[cursor % SECTION_COLOR_CYCLE.length];
    if (i > 0 && color === colors[i - 1]) {
      cursor++;
      color = SECTION_COLOR_CYCLE[cursor % SECTION_COLOR_CYCLE.length];
    }
    colors.push(color);
    cursor++;
  }
  return colors;
}

function mmss(sec: number): string {
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatMi(mi: number): string {
  const rounded = Math.round(mi * 100) / 100;
  return Number.isInteger(rounded) ? `${rounded}mi` : `${rounded.toFixed(2)}mi`;
}

function sectionTooltip(s: WorkoutSection): string {
  const paceStr = s.paceSec ? `${mmss(s.paceSec)}/mi` : null;
  const mi = s.endMi - s.startMi;
  const withDist = (text: string) => mi > 0 ? `${formatMi(mi)} @ ${text}` : text;
  switch (s.kind) {
    case "warmup":
    case "easy":
    case "cooldown":
      return withDist(paceStr ? `Conversational pace ${mmss(s.paceSec!)}` : "Conversational pace");
    case "work":
      return withDist(paceStr ?? "Work");
    case "rest":
      return withDist(/walk/i.test(s.label) ? "Walking rest" : "Rest");
    case "strength":
      return withDist("Strength");
    default:
      return s.label;
  }
}

// Bearing in degrees (0 = north, clockwise) from point a to point b, standard
// great-circle formula — used to orient each direction-arrow marker.
function bearingDeg(a: [number, number], b: [number, number]): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const [lat1, lon1] = [toRad(a[0]), toRad(a[1])];
  const [lat2, lon2] = [toRad(b[0]), toRad(b[1])];
  const dLon = lon2 - lon1;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// Green (#22c55e) -> red (#ef4444) lerp by route progress (0 = start, 1 =
// finish) — reuses the exact two hex colors the start/finish circle markers
// below already use, so the arrow gradient matches the app's existing
// start/finish color convention instead of inventing a new palette.
const ARROW_START_RGB = [34, 197, 94] as const;
const ARROW_END_RGB = [239, 68, 68] as const;
function lerpArrowColor(t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  const [r, g, b] = ARROW_START_RGB.map((c, i) => Math.round(c + (ARROW_END_RGB[i] - c) * clamped));
  return `rgb(${r}, ${g}, ${b})`;
}

// Places a small rotated triangle marker every ~4% of total route distance
// (~25 arrows across a typical run) along `points`, colored by progress and
// pointed in the direction of travel — pure Leaflet divIcon, no plugin, so
// rotation is done via a CSS transform on the icon's inner SVG rather than a
// marker-rotation library.
function addDirectionArrows(L: typeof import("leaflet"), map: import("leaflet").Map, points: RoutePoint[]): void {
  if (points.length < 2) return;
  const totalMi = points[points.length - 1][4] || 1;
  const STEP_FRACTION = 0.04;
  let nextMi = 0;
  for (let i = 0; i < points.length - 1; i++) {
    if (points[i][4] < nextMi) continue;
    const a: [number, number] = [points[i][0], points[i][1]];
    const b: [number, number] = [points[i + 1][0], points[i + 1][1]];
    if (a[0] === b[0] && a[1] === b[1]) continue; // duplicate point (paused GPS) — bearing undefined
    const heading = bearingDeg(a, b);
    const color = lerpArrowColor(points[i][4] / totalMi);
    const icon = L.divIcon({
      className: "",
      html: `<svg width="16" height="16" viewBox="0 0 16 16" style="transform: rotate(${heading}deg)">
               <polygon points="8,1 14,14 8,10.5 2,14" fill="${color}" stroke="#fff" stroke-width="1" />
             </svg>`,
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
    L.marker(a, { icon, interactive: false }).addTo(map);
    nextMi += totalMi * STEP_FRACTION;
  }
}

interface UseRouteMapArgs {
  mapContainer: React.RefObject<HTMLDivElement>;
  activityId: string | number | null;
  workoutSections: WorkoutSection[];
  tracks: RouteMapTrack[];
  hoveredTrackIdx: number | null;
  // Index into workoutSections currently hovered in an external sidebar
  // list (see MobileRouteClient.tsx) — drives the same walking-ants
  // highlight the map's own section-line hover already triggers, so hovering
  // the list does the identical thing as hovering the line on the map.
  hoveredSectionIdx?: number | null;
}

interface UseRouteMapResult {
  loading: boolean;
  error: string | null;
  name: string | null;
  stats: string | null;
  showingWorkoutOverlay: boolean;
  distanceMismatch: { plannedMi: number; actualMi: number } | null;
  view: "street" | "satellite";
  setView: (v: "street" | "satellite") => void;
}

export function useRouteMap({ mapContainer, activityId, workoutSections, tracks, hoveredTrackIdx, hoveredSectionIdx = null }: UseRouteMapArgs): UseRouteMapResult {
  const [name, setName] = useState<string | null>(null);
  const [stats, setStats] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showingWorkoutOverlay, setShowingWorkoutOverlay] = useState(false);
  const [distanceMismatch, setDistanceMismatch] = useState<{ plannedMi: number; actualMi: number } | null>(null);
  const [view, setView] = useState<"street" | "satellite">("street");
  const viewRef = useRef(view);
  viewRef.current = view;

  const pointsRef = useRef<RoutePoint[] | null>(null);
  const highlightLayerRef = useRef<import("leaflet").Polyline | null>(null);
  // Every polyline batch belonging to each section index — a section's
  // route can be non-contiguous (e.g. reps that revisit an earlier street),
  // so one section maps to 1+ layers, all of which need the ants effect
  // toggled together for the list-hover to visually match hovering the line.
  const sectionLayersRef = useRef<Map<number, import("leaflet").Polyline[]>>(new Map());
  const layersRef = useRef<{
    map: import("leaflet").Map;
    street: import("leaflet").TileLayer;
    satellite: import("leaflet").TileLayer;
  } | null>(null);

  useEffect(() => {
    if (!activityId) return;
    let cancelled = false;
    let map: import("leaflet").Map | null = null;

    (async () => {
      try {
        const res = await fetch(`/api/garmin/route/${activityId}`);
        const data = await res.json() as {
          name?: string | null;
          distance?: number | null;
          elapsedTime?: string | number | null;
          points?: RoutePoint[];
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok || !data.points?.length) throw new Error(data.error ?? "No GPS data");
        setName(data.name ?? null);

        if (data.distance) {
          const parts = [`${data.distance.toFixed(2)} mi`];
          const secs = (() => {
            const v = data.elapsedTime;
            if (v == null) return null;
            if (typeof v === "number") return v;
            const p = v.split(":").map(Number);
            return p.some(isNaN) ? null : p.reduce((acc, x) => acc * 60 + x, 0);
          })();
          if (secs) {
            const mm = Math.floor(secs / 60), ss = Math.round(secs % 60);
            parts.push(`${mm}:${String(ss).padStart(2, "0")}`);
            const spm = secs / data.distance;
            parts.push(`${Math.floor(spm / 60)}:${String(Math.round(spm % 60)).padStart(2, "0")}/mi`);
          }
          setStats(parts.join(" · "));
        }

        const L = await import("leaflet");
        if (cancelled || !mapContainer.current) return;

        map = L.map(mapContainer.current, { zoomControl: true, attributionControl: true });
        const street = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        });
        const satellite = L.tileLayer(
          "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
          {
            maxZoom: 19,
            attribution: "Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics",
          },
        );
        (viewRef.current === "satellite" ? satellite : street).addTo(map);
        layersRef.current = { map, street, satellite };

        const points = data.points;
        pointsRef.current = points;
        sectionLayersRef.current.clear();

        if (workoutSections.length > 0) {
          setShowingWorkoutOverlay(true);

          const plannedMi = workoutSections.reduce((max, s) => Math.max(max, s.endMi), 0);
          const actualMi = points[points.length - 1][4];
          if (plannedMi > 0 && Math.abs(plannedMi - actualMi) / plannedMi > 0.05) {
            setDistanceMismatch({ plannedMi, actualMi });
          }

          const sectionFor = (mi: number, prevIdx: number): number => {
            const idx = workoutSections.findIndex(s => s.endMi > s.startMi && mi >= s.startMi && mi < s.endMi);
            if (idx !== -1) return idx;
            const lastReal = [...workoutSections].reverse().find(s => s.endMi > s.startMi);
            if (lastReal && mi >= lastReal.endMi) return workoutSections.indexOf(lastReal);
            return prevIdx;
          };

          const sectionColors = assignSectionColors(workoutSections);

          const setSectionAnts = (idx: number, on: boolean) => {
            for (const layer of sectionLayersRef.current.get(idx) ?? []) {
              layer.setStyle({ dashArray: on ? "1,14" : undefined });
              const el = layer.getElement();
              if (on) el?.classList.add("route-highlight-flash");
              else el?.classList.remove("route-highlight-flash");
            }
          };

          let batch: [number, number][] = [[points[0][0], points[0][1]]];
          let batchSection = sectionFor(points[0][4], 0);
          const flush = (pts: [number, number][], idx: number) => {
            if (pts.length < 2 || idx < 0) return;
            const section = workoutSections[idx];
            const layer = L.polyline(pts, { color: sectionColors[idx], weight: 5, opacity: 0.9 })
              .addTo(map!)
              // offset nudges the tooltip clear of the cursor — sticky mode
              // otherwise centers it right under the pointer, where it stole
              // hover/click focus from the line and nearby map controls.
              .bindTooltip(sectionTooltip(section), { sticky: true, offset: [16, 0] });
            // Walking-ants dash animation while hovered — same marching-ants
            // CSS (app/globals.css) already used for the mix-track hover
            // highlight, applied directly to this section's own polyline
            // element instead of a separate overlay layer, and reset on
            // mouseout since setStyle's dashArray persists otherwise.
            layer.on("mouseover", () => setSectionAnts(idx, true));
            layer.on("mouseout", () => setSectionAnts(idx, false));
            const existing = sectionLayersRef.current.get(idx) ?? [];
            existing.push(layer);
            sectionLayersRef.current.set(idx, existing);
          };
          for (let i = 1; i < points.length; i++) {
            const idx = sectionFor(points[i][4], batchSection);
            batch.push([points[i][0], points[i][1]]);
            if (idx !== batchSection || i === points.length - 1) {
              flush(batch, batchSection);
              batch = [[points[i][0], points[i][1]]];
              batchSection = idx;
            }
          }

          workoutSections.forEach((s, idx) => {
            if (s.kind !== "rest" || s.endMi > s.startMi) return;
            let nearest = 0, nearestDiff = Infinity;
            for (let i = 0; i < points.length; i++) {
              const diff = Math.abs(points[i][4] - s.startMi);
              if (diff < nearestDiff) { nearest = i; nearestDiff = diff; }
            }
            const pt = points[nearest];
            L.circleMarker([pt[0], pt[1]], {
              radius: 6, color: "#fff", weight: 2, fillColor: sectionColors[idx], fillOpacity: 1,
            }).addTo(map!).bindTooltip(sectionTooltip(s), { sticky: true, offset: [16, 0] });
          });
        } else {
          const speeds = points.map(p => p[2]).filter((s): s is number => s !== null && s > 0.5).sort((a, b) => a - b);
          const q = (f: number) => speeds.length ? speeds[Math.min(speeds.length - 1, Math.floor(f * speeds.length))] : 0;
          const q1 = q(0.25), q2 = q(0.5), q3 = q(0.75);
          const colorFor = (s: number | null) => {
            if (s === null || speeds.length === 0) return SEGMENT_COLORS[1];
            if (s <= q1) return SEGMENT_COLORS[0];
            if (s <= q2) return SEGMENT_COLORS[1];
            if (s <= q3) return SEGMENT_COLORS[2];
            return SEGMENT_COLORS[3];
          };

          let batch: [number, number][] = [[points[0][0], points[0][1]]];
          let batchColor = colorFor(points[0][2]);
          for (let i = 1; i < points.length; i++) {
            const c = colorFor(points[i][2]);
            batch.push([points[i][0], points[i][1]]);
            if (c !== batchColor || i === points.length - 1) {
              L.polyline(batch, { color: batchColor, weight: 4, opacity: 0.9 }).addTo(map);
              batch = [[points[i][0], points[i][1]]];
              batchColor = c;
            }
          }
        }

        addDirectionArrows(L, map, points);

        L.circleMarker([points[0][0], points[0][1]], {
          radius: 7, color: "#fff", weight: 2, fillColor: "#22c55e", fillOpacity: 1,
        }).addTo(map).bindTooltip("Start");
        const lastPt = points[points.length - 1];
        L.circleMarker([lastPt[0], lastPt[1]], {
          radius: 7, color: "#fff", weight: 2, fillColor: "#ef4444", fillOpacity: 1,
        }).addTo(map).bindTooltip("Finish");

        map.fitBounds(L.latLngBounds(points.map(p => [p[0], p[1]] as [number, number])), { padding: [24, 24] });
        setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load route");
          setLoading(false);
        }
      }
    })();

    return () => { cancelled = true; layersRef.current = null; pointsRef.current = null; map?.remove(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activityId]);

  useEffect(() => {
    const l = layersRef.current;
    if (!l) return;
    if (view === "satellite") {
      l.map.removeLayer(l.street);
      l.satellite.addTo(l.map);
    } else {
      l.map.removeLayer(l.satellite);
      l.street.addTo(l.map);
    }
  }, [view]);

  useEffect(() => {
    const l = layersRef.current;
    const points = pointsRef.current;
    if (highlightLayerRef.current) {
      highlightLayerRef.current.remove();
      highlightLayerRef.current = null;
    }
    if (hoveredTrackIdx === null || !l || !points || !tracks.length) return;
    const track = tracks[hoveredTrackIdx];
    if (!track) return;
    const startSec = track.startsAtSec;
    const endSec = track.startsAtSec + (track.durationSec ?? 0);
    const seg = points.filter(p => {
      const t = p[3];
      return t !== null && t >= startSec && t <= endSec;
    });
    if (seg.length < 2) return;
    import("leaflet").then(L => {
      if (highlightLayerRef.current) return;
      const layer = L.polyline(seg.map(p => [p[0], p[1]] as [number, number]), {
        color: "#ffffff",
        weight: 7,
        opacity: 1,
        dashArray: "1,14",
        lineCap: "round",
        className: "route-highlight-flash",
      }).addTo(l.map);
      highlightLayerRef.current = layer;
    });
  }, [hoveredTrackIdx, tracks]);

  // External sidebar-list hover (see MobileRouteClient.tsx) drives the same
  // ants effect the map's own section-line hover already triggers directly —
  // toggle off whichever section previously had it, on for the new one.
  const prevHoveredSectionRef = useRef<number | null>(null);
  useEffect(() => {
    const prev = prevHoveredSectionRef.current;
    if (prev !== null) {
      for (const layer of sectionLayersRef.current.get(prev) ?? []) {
        layer.setStyle({ dashArray: undefined });
        layer.getElement()?.classList.remove("route-highlight-flash");
      }
    }
    if (hoveredSectionIdx !== null) {
      for (const layer of sectionLayersRef.current.get(hoveredSectionIdx) ?? []) {
        layer.setStyle({ dashArray: "1,14" });
        layer.getElement()?.classList.add("route-highlight-flash");
      }
    }
    prevHoveredSectionRef.current = hoveredSectionIdx;
  }, [hoveredSectionIdx]);

  return { loading, error, name, stats, showingWorkoutOverlay, distanceMismatch, view, setView };
}
