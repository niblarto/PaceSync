"use client";

import { useRef } from "react";
import Link from "next/link";
import { useRouteMap } from "@/hooks/useRouteMap";

// Full-screen mobile route view for a pinned run — deliberately no
// side-by-side tracklist panel (unlike the desktop RouteMapLightbox), so the
// map gets the whole phone-width viewport. Reuses useRouteMap for identical
// Leaflet setup/coloring/start-finish markers plus the green->red direction
// arrows it now draws.
export function MobileRouteClient({ activityId }: { activityId: string }) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const { loading, error, name, stats, view, setView } = useRouteMap({
    mapContainer, activityId, workoutSections: [], tracks: [], hoveredTrackIdx: null,
  });

  return (
    <div className="fixed inset-0 flex flex-col bg-slate-950 text-slate-100">
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-white/10 bg-slate-900/90">
        <div className="min-w-0 flex items-center gap-3">
          <Link href="/mobile" className="text-slate-400 hover:text-slate-200 text-xl leading-none shrink-0">
            ←
          </Link>
          <div className="min-w-0">
            <h1 className="font-semibold text-sm truncate">🗺 {name ?? "Route"}</h1>
            {stats && <p className="text-xs text-sky-300 font-medium">{stats}</p>}
          </div>
        </div>
        <div className="flex rounded-lg overflow-hidden border border-white/10 text-xs shrink-0">
          <button
            onClick={() => setView("street")}
            className={`px-2.5 py-1 transition-colors ${view === "street" ? "bg-sky-500/20 text-sky-300" : "text-slate-500"}`}
          >
            Map
          </button>
          <button
            onClick={() => setView("satellite")}
            className={`px-2.5 py-1 transition-colors ${view === "satellite" ? "bg-sky-500/20 text-sky-300" : "text-slate-500"}`}
          >
            Satellite
          </button>
        </div>
      </div>

      <div className="relative flex-1 bg-slate-800">
        <div ref={mapContainer} className="absolute inset-0" />
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-sm">
            Loading route…
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center text-red-400 text-sm px-6 text-center">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
