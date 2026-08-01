"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import "leaflet/dist/leaflet.css";
import { useRunnaData } from "./RunnaCard";
import { playInSpotify } from "./TrackRow";
import { useRunningPlaylist } from "./useRunningPlaylist";
import { deleteTrackFromLibrary } from "@/lib/track-delete-client";
import { useRouteMap, type WorkoutSection } from "@/hooks/useRouteMap";

// Full-page route + per-track pace/BPM/SPM detail for a completed run,
// linked from RunnaSummaryCard's flat tracklist. Reuses the same GPS-route
// rendering (hooks/useRouteMap.ts, extracted from RouteMapLightbox.tsx) and
// the same track-delete flow (lib/track-delete-client.ts) as the rest of
// the app, adding two things the flat list doesn't have: a map overlay of
// where each track played, and persistent per-track BPM correction buttons.

interface TrackPacing {
  uri: string | null;
  name: string;
  artist: string;
  segment: string;
  startsAtSec: number;
  durationSec: number;
  targetPaceSec: number | null;
  actualPaceSec: number | null;
  actualSpm: number | null;
  verdict: "on" | "fast" | "slow" | "unknown";
  tempo: number | null;
  energy: number | null;
  inLibrary?: boolean;
}

function fmtPaceSec(s: number | null): string {
  if (!s) return "—";
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}

function mmss(sec: number): string {
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

const VERDICT_STYLE: Record<TrackPacing["verdict"], string> = {
  on: "bg-green-500/10 border-green-500/30 text-green-300",
  fast: "bg-red-500/10 border-red-500/30 text-red-300",
  slow: "bg-sky-500/10 border-sky-500/30 text-sky-300",
  unknown: "bg-slate-800/40 border-white/5 text-slate-500",
};

export function RunDetailClient({ date, title }: { date: string; title: string }) {
  const { data: session } = useSession();
  const { id: RUNNING_PLAYLIST_ID } = useRunningPlaylist();
  const { pastRuns } = useRunnaData();
  const run = useMemo(() => pastRuns.find(r => r.date === date && r.title === title), [pastRuns, date, title]);

  const [tracks, setTracks] = useState<TrackPacing[] | null>(null);
  const [activityId, setActivityId] = useState<string | number | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deletedUris, setDeletedUris] = useState<Set<string>>(new Set());
  const [pendingBpm, setPendingBpm] = useState<Set<string>>(new Set());
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [workoutSections, setWorkoutSections] = useState<WorkoutSection[]>([]);
  const mapContainer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`/api/garmin/run-pacing?date=${date}&title=${encodeURIComponent(title)}`)
      .then(r => r.json())
      .then((d: { tracks?: TrackPacing[]; activityId?: string | number | null; summary?: string | null; error?: string }) => {
        if (d.error) { setError(d.error); return; }
        setTracks(d.tracks ?? []);
        setActivityId(d.activityId ?? null);
        setSummary(d.summary ?? null);
      })
      .catch(e => setError(e instanceof Error ? e.message : "Failed to load"));
  }, [date, title]);

  useEffect(() => {
    if (!run?.planSteps?.length) return;
    fetch("/api/runna/workout-segments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ segments: run.planSteps }),
    })
      .then(r => r.json())
      .then((d: { sections?: WorkoutSection[] }) => setWorkoutSections(d.sections ?? []))
      .catch(() => {});
  }, [run?.planSteps]);

  const routeTracks = useMemo(
    () => (tracks ?? []).map(t => ({ uri: t.uri, name: t.name, artist: t.artist, startsAtSec: t.startsAtSec, durationSec: t.durationSec, tempo: t.tempo })),
    [tracks],
  );
  const { loading, error: mapError, name, stats, showingWorkoutOverlay, distanceMismatch, view, setView } = useRouteMap({
    mapContainer, activityId, workoutSections, tracks: routeTracks, hoveredTrackIdx: hoveredIdx,
  });

  function deleteTrack(t: TrackPacing) {
    if (!t.uri) return;
    const uri = t.uri;
    setDeletedUris(prev => { const next = new Set(prev); next.add(uri); return next; });
    deleteTrackFromLibrary(uri, RUNNING_PLAYLIST_ID);
  }

  function nudgeBpm(t: TrackPacing, direction: "slower" | "faster") {
    if (!t.uri || t.tempo == null) return;
    const uri = t.uri;
    setPendingBpm(prev => { const next = new Set(prev); next.add(uri); return next; });
    fetch("/api/tracks/bpm-override", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uri, direction, baseline: t.tempo }),
    })
      .then(r => r.json())
      .then((d: { override?: { value: number } }) => {
        if (!d.override) return;
        setTracks(prev => prev?.map(pt => (pt.uri === uri ? { ...pt, tempo: d.override!.value } : pt)) ?? prev);
      })
      .catch(() => {})
      .finally(() => setPendingBpm(prev => { const next = new Set(prev); next.delete(uri); return next; }));
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      <div className="flex items-center justify-between px-5 py-3 border-b border-white/10">
        <div className="min-w-0">
          <h1 className="font-semibold text-sm truncate">🗺 {name ?? run?.title ?? title}</h1>
          <p className="text-xs text-slate-500">
            {stats && <span className="text-sky-300 font-medium">{stats} · </span>}
            {showingWorkoutOverlay ? "colour = workout section — hover for target" : "colour = pace (blue slow → red fast)"}
          </p>
          {distanceMismatch && (
            <p className="text-xs text-amber-400 mt-0.5">
              ⚠ Workout planned {distanceMismatch.plannedMi.toFixed(2)}mi, this route covers {distanceMismatch.actualMi.toFixed(2)}mi.
            </p>
          )}
          {summary && <p className="text-xs text-slate-500 mt-0.5">{summary}</p>}
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
          <Link href="/dashboard" className="text-xs text-slate-400 hover:text-slate-200 underline">
            ← Back
          </Link>
        </div>
      </div>

      <div className="flex" style={{ height: "calc(100vh - 57px)" }}>
        <div className="relative flex-1 bg-slate-800">
          <div ref={mapContainer} className="absolute inset-0" />
          {loading && !mapError && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-400">
              Loading route…
            </div>
          )}
          {(mapError || error) && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-red-400 px-6 text-center">
              {mapError ?? error}
            </div>
          )}
        </div>

        <div className="w-96 shrink-0 border-l border-white/10 bg-slate-950/60 overflow-y-auto">
          <p className="sticky top-0 px-3 py-2 text-xs font-medium text-slate-400 bg-slate-950/90 backdrop-blur-sm border-b border-white/10">
            🎧 Track detail — hover to see where it played on the route
          </p>
          <div className="divide-y divide-white/5">
            {(tracks ?? []).map((t, i) => {
              const isDeleted = !!(t.uri && deletedUris.has(t.uri)) || t.inLibrary === false;
              const nudging = !!(t.uri && pendingBpm.has(t.uri));
              return (
                <div
                  key={`${t.uri ?? t.name}-${i}`}
                  onMouseEnter={() => setHoveredIdx(i)}
                  onMouseLeave={() => setHoveredIdx(prev => (prev === i ? null : prev))}
                  className={`px-3 py-2.5 transition-colors ${hoveredIdx === i ? "bg-cyan-500/15" : ""} ${isDeleted ? "opacity-40 line-through" : ""}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => { if (t.uri) playInSpotify(t.uri, session?.accessToken).catch(() => {}); }}
                      disabled={!t.uri}
                      className="min-w-0 flex-1 text-left hover:underline disabled:no-underline"
                      title={t.uri ? "Play in Spotify" : undefined}
                    >
                      <p className="text-sm text-slate-200 truncate">{t.name}</p>
                      <p className="text-xs text-slate-500 truncate">{t.artist}</p>
                    </button>
                    <p className="text-xs text-slate-500 tabular-nums shrink-0">{mmss(t.startsAtSec)}</p>
                  </div>

                  <div className={`mt-1.5 flex items-center gap-2 rounded border px-2 py-1 text-xs ${VERDICT_STYLE[t.verdict]}`}>
                    <span title="Target pace">🎯 {fmtPaceSec(t.targetPaceSec)}/mi</span>
                    <span title="Actual pace">🏃 {fmtPaceSec(t.actualPaceSec)}/mi</span>
                    {t.tempo != null && <span title="Track BPM (override-applied)">🎵 {Math.round(t.tempo)} bpm</span>}
                    {t.actualSpm != null && <span title="Actual cadence (steps/min)">👟 {t.actualSpm} spm</span>}
                  </div>

                  {t.uri && !isDeleted && (
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <button
                        onClick={() => nudgeBpm(t, "slower")}
                        disabled={nudging || t.tempo == null}
                        title="Music was too slow — lower its BPM by 1 so it's picked for slower-paced runs next time"
                        className="rounded bg-slate-800/60 hover:bg-slate-700/60 disabled:opacity-40 px-2 py-0.5 text-[11px] transition-colors"
                      >
                        🐢 Too slow
                      </button>
                      <button
                        onClick={() => nudgeBpm(t, "faster")}
                        disabled={nudging || t.tempo == null}
                        title="Music was too fast — raise its BPM by 1 so it's picked for faster-paced runs next time"
                        className="rounded bg-slate-800/60 hover:bg-slate-700/60 disabled:opacity-40 px-2 py-0.5 text-[11px] transition-colors"
                      >
                        🐇 Too fast
                      </button>
                      <button
                        onClick={() => deleteTrack(t)}
                        title="Delete this track from the library and Spotify playlist"
                        className="ml-auto rounded bg-red-500/10 hover:bg-red-500/20 text-red-300 px-2 py-0.5 text-[11px] transition-colors"
                      >
                        🗑 Delete
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            {tracks?.length === 0 && (
              <p className="px-3 py-4 text-sm text-slate-500">No saved tracklist for this run.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
