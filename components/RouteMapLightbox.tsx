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
  onClose: () => void;
}

type RoutePoint = [number, number, number | null]; // lat, lng, speed mph

const SEGMENT_COLORS = ["#3b82f6", "#22c55e", "#f97316", "#ef4444"]; // slow → fast

export function RouteMapLightbox({ activityId, label, onClose }: Props) {
  const mapRef = useRef<HTMLDivElement>(null);
  const [name, setName] = useState<string | null>(null);
  const [stats, setStats] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        }).addTo(map);

        const points = data.points;

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

    return () => { cancelled = true; map?.remove(); };
  }, [activityId]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl rounded-2xl bg-slate-900 border border-white/10 overflow-hidden shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/10">
          <div className="min-w-0">
            <h3 className="font-semibold text-sm truncate">🗺 {name ?? label}</h3>
            <p className="text-xs text-slate-500">
              {stats && <span className="text-sky-300 font-medium">{stats} · </span>}
              colour = pace (blue slow → red fast)
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
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
        <div className="relative h-[60vh] min-h-[320px] bg-slate-800">
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
