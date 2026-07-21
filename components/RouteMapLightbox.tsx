"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "leaflet/dist/leaflet.css";

// Lightbox showing an activity's GPS route on OpenStreetMap tiles, drawn
// straight from GarminDB — no Garmin Connect round-trip. The polyline is
// coloured by pace quartile (slow blue → green → orange → fast red, like
// Garmin's own route view).

interface Props {
  activityId: string | number;
  label: string;
  /** Raw Runna workout segment lines (e.g. "1.5mi at 8:35/mi") — when given,
      the route is colour-coded by workout section instead of measured pace,
      with a hover tooltip showing each section's target. */
  workoutSegments?: string[];
  onClose: () => void;
}

type RoutePoint = [number, number, number | null, number | null, number]; // lat, lng, speed mph, elapsed sec, cumulative mi

interface WorkoutSection {
  label: string;
  kind: "warmup" | "work" | "easy" | "cooldown" | "rest" | "strength";
  startSec: number;
  endSec: number;
  startMi: number;
  endMi: number;
  paceSec: number | null;
}

const SEGMENT_COLORS = ["#3b82f6", "#22c55e", "#f97316", "#ef4444"]; // slow → fast

// Workout-section overlay: colours are assigned by position in the section
// list, not by kind — a workout with five consecutive "work" segments at
// different paces (e.g. a progressive long run) needs each one visually
// distinct, not all sharing one colour. High-contrast, evenly-spaced hues
// so no two *adjacent* colours in this cycle read as similar; picked to
// stay legible over both map and satellite tiles.
const SECTION_COLOR_CYCLE = [
  "#ef4444", // red
  "#22c55e", // green
  "#a855f7", // purple
  "#f59e0b", // amber
  "#06b6d4", // cyan
  "#ec4899", // pink
  "#84cc16", // lime
  "#6366f1", // indigo
];

// Colours the section list positionally, skipping a repeat against the
// immediately preceding section (can happen when the cycle wraps for very
// long workouts) so consecutive sections are never visually indistinguishable.
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
  // Whole numbers read cleaner without trailing zeros (2mi, not 2.00mi);
  // everything else gets two decimal places. Rounded first so a cumulative
  // float sum landing at e.g. 0.9999999999 still reads as the intended 1mi.
  const rounded = Math.round(mi * 100) / 100;
  return Number.isInteger(rounded) ? `${rounded}mi` : `${rounded.toFixed(2)}mi`;
}

// Hover label per the section's kind/pace/distance — "1.5mi @ Conversational
// pace 9:15" for warmup/easy, "2mi @ 7:55/mi" for work, "⅛mi @ Walking rest"
// for a rest section whose label mentions walking. A stationary (zero-
// distance) rest has no mileage to show — just "Rest".
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

export function RouteMapLightbox({ activityId, label, workoutSegments, onClose }: Props) {
  const mapRef = useRef<HTMLDivElement>(null);
  const [name, setName] = useState<string | null>(null);
  const [stats, setStats] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showingWorkoutOverlay, setShowingWorkoutOverlay] = useState(false);
  const [distanceMismatch, setDistanceMismatch] = useState<{ plannedMi: number; actualMi: number } | null>(null);
  const [view, setView] = useState<"street" | "satellite">("street");
  const viewRef = useRef(view);
  viewRef.current = view;
  const layersRef = useRef<{
    map: import("leaflet").Map;
    street: import("leaflet").TileLayer;
    satellite: import("leaflet").TileLayer;
  } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    let map: import("leaflet").Map | null = null;

    (async () => {
      try {
        const [res, sectionsRes] = await Promise.all([
          fetch(`/api/garmin/route/${activityId}`),
          workoutSegments?.length
            ? fetch("/api/runna/workout-segments", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ segments: workoutSegments }),
              }).catch(() => null)
            : Promise.resolve(null),
        ]);
        const data = await res.json() as {
          name?: string | null;
          distance?: number | null;
          elapsedTime?: string | number | null;
          points?: RoutePoint[];
          error?: string;
        };
        const sections: WorkoutSection[] = sectionsRes
          ? ((await sectionsRes.json().catch(() => null)) as { sections?: WorkoutSection[] } | null)?.sections ?? []
          : [];
        if (cancelled) return;
        if (!res.ok || !data.points?.length) throw new Error(data.error ?? "No GPS data");
        setName(data.name ?? null);

        // "4.56 mi · 39:12 · 8:36/mi" — actual mileage covered on the course
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
        if (cancelled || !mapRef.current) return;

        map = L.map(mapRef.current, { zoomControl: true, attributionControl: true });
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

        if (sections.length > 0) {
          setShowingWorkoutOverlay(true);

          // Warn when the route's actual distance falls short of the
          // workout's total planned mileage — the last section(s) would
          // otherwise silently bucket against too little real ground (or,
          // for a route that overshoots, "extra" points at the end all pile
          // into the final section, which is still shown but worth knowing).
          const plannedMi = sections.reduce((max, s) => Math.max(max, s.endMi), 0);
          const actualMi = points[points.length - 1][4];
          if (plannedMi > 0 && Math.abs(plannedMi - actualMi) / plannedMi > 0.05) {
            setDistanceMismatch({ plannedMi, actualMi });
          }

          // Workout-section overlay: colour each point by which planned
          // section its cumulative GPS distance falls into — distance, not
          // elapsed time, since Runna workouts are distance-based and a
          // pacing variance on the day shouldn't shrink/stretch which points
          // count as "warm up" vs "work". A stationary (non-walking) rest has
          // zero planned distance, so it's naturally skipped as a bucket —
          // its GPS points (barely any distance covered while stopped) fall
          // into whichever real section brackets them by mileage, same as
          // the actual pause plays out on the ground.
          const sectionFor = (mi: number, prevIdx: number): number => {
            const idx = sections.findIndex(s => s.endMi > s.startMi && mi >= s.startMi && mi < s.endMi);
            if (idx !== -1) return idx;
            const lastReal = [...sections].reverse().find(s => s.endMi > s.startMi);
            if (lastReal && mi >= lastReal.endMi) return sections.indexOf(lastReal);
            return prevIdx;
          };

          const sectionColors = assignSectionColors(sections);

          let batch: [number, number][] = [[points[0][0], points[0][1]]];
          let batchSection = sectionFor(points[0][4], 0);
          const flush = (pts: [number, number][], idx: number) => {
            if (pts.length < 2 || idx < 0) return;
            const section = sections[idx];
            L.polyline(pts, { color: sectionColors[idx], weight: 5, opacity: 0.9 })
              .addTo(map!)
              .bindTooltip(sectionTooltip(section), { sticky: true });
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

          // Stationary (non-walking) rests have zero planned distance, so
          // they leave no coloured stretch of their own — mark the spot on
          // the route instead, at the point closest to the rest's position
          // in the cumulative-distance timeline.
          sections.forEach((s, idx) => {
            if (s.kind !== "rest" || s.endMi > s.startMi) return;
            let nearest = 0, nearestDiff = Infinity;
            for (let i = 0; i < points.length; i++) {
              const diff = Math.abs(points[i][4] - s.startMi);
              if (diff < nearestDiff) { nearest = i; nearestDiff = diff; }
            }
            const pt = points[nearest];
            L.circleMarker([pt[0], pt[1]], {
              radius: 6, color: "#fff", weight: 2, fillColor: sectionColors[idx], fillOpacity: 1,
            }).addTo(map!).bindTooltip(sectionTooltip(s), { sticky: true });
          });
        } else {
          // Pace quartiles over the recorded speeds → colour buckets
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

          // Draw consecutive segments, batching runs of the same colour
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

        // Start / finish markers (circle markers avoid Leaflet's icon asset issues)
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

    return () => { cancelled = true; layersRef.current = null; map?.remove(); };
  }, [activityId]);

  // Swap the base tiles when the street/satellite toggle changes.
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

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[72rem] rounded-2xl bg-slate-900 border border-white/10 overflow-hidden shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/10">
          <div className="min-w-0">
            <h3 className="font-semibold text-sm truncate">🗺 {name ?? label}</h3>
            <p className="text-xs text-slate-500">
              {stats && <span className="text-sky-300 font-medium">{stats} · </span>}
              {showingWorkoutOverlay ? "colour = workout section — hover for target" : "colour = pace (blue slow → red fast)"}
            </p>
            {distanceMismatch && (
              <p className="text-xs text-amber-400 mt-0.5">
                ⚠ Workout plans {formatMi(distanceMismatch.plannedMi)}, this route covers {formatMi(distanceMismatch.actualMi)} — sections past the end of the route are bunched into the last one.
              </p>
            )}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <div className="flex rounded-lg overflow-hidden border border-white/10 text-xs">
              <button
                onClick={() => setView("street")}
                className={`px-2.5 py-1 transition-colors ${view === "street" ? "bg-sky-500/20 text-sky-300" : "text-slate-500 hover:text-slate-300"}`}
              >
                Map
              </button>
              <button
                onClick={() => setView("satellite")}
                className={`px-2.5 py-1 transition-colors ${view === "satellite" ? "bg-sky-500/20 text-sky-300" : "text-slate-500 hover:text-slate-300"}`}
              >
                Satellite
              </button>
            </div>
            <a
              href={`https://connect.garmin.com/app/activity/${activityId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-slate-400 hover:text-slate-200 underline"
            >
              Garmin Connect ↗
            </a>
            <button
              onClick={onClose}
              className="text-slate-500 hover:text-slate-200 text-xl leading-none transition-colors"
              title="Close (Esc)"
            >
              ×
            </button>
          </div>
        </div>
        <div className="relative h-[69vh] min-h-[368px] bg-slate-800">
          <div ref={mapRef} className="absolute inset-0" />
          {loading && !error && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-400">
              Loading route…
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-red-400">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
