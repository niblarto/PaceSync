"use client";

import { useState, useEffect } from "react";
import type { RunnaWorkout, RunnaPastRun, WorkoutType } from "@/app/api/runna/workouts/route";
import type { TrackWithBPM } from "@/types";
import { RouteMapLightbox } from "./RouteMapLightbox";

interface PaceSpmRow { bucket: number; avg_spm: number; records: number; }

let paceSpmCache: PaceSpmRow[] | null = null;
let paceSpmPromise: Promise<void> | null = null;

function usePaceSpm(enabled: boolean): PaceSpmRow[] {
  const [rows, setRows] = useState<PaceSpmRow[]>(paceSpmCache ?? []);
  useEffect(() => {
    if (!enabled) return;
    if (paceSpmCache) { setRows(paceSpmCache); return; }
    if (!paceSpmPromise) {
      paceSpmPromise = fetch("/api/garmin/pace-spm")
        .then(r => r.json())
        .then((d: unknown) => { if (Array.isArray(d)) paceSpmCache = d as PaceSpmRow[]; })
        .catch(() => {});
    }
    paceSpmPromise.then(() => { if (paceSpmCache) setRows(paceSpmCache); });
  }, [enabled]);
  return rows;
}

function parsePacesFromSegments(segments: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const re = /(\d+:\d{2})\/mi/g;
  for (const seg of segments) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(seg)) !== null) {
      if (!seen.has(m[1])) { seen.add(m[1]); result.push(m[1]); }
    }
  }
  return result;
}

function lookupSpm(pace: string, rows: PaceSpmRow[]): number | null {
  const [min, sec] = pace.split(":").map(Number);
  const secs = min * 60 + sec;
  const bucket = Math.floor(secs / 5) * 5;
  return rows.find(r => r.bucket === bucket)?.avg_spm ?? null;
}

// For workouts that only say "conversational pace" with no explicit X:XX/mi,
// find the slowest (no-faster-than) pace from easy run workouts in the schedule.
function findEasyRunPace(workouts: RunnaWorkout[], paceSpm: PaceSpmRow[]): { pace: string; spm: number } | null {
  let slowestSecs = 0;
  let slowestPace: string | null = null;
  for (const w of workouts) {
    if (w.type !== "easy_run") continue;
    for (const p of parsePacesFromSegments(w.segments)) {
      const [min, sec] = p.split(":").map(Number);
      const secs = min * 60 + sec;
      if (secs > slowestSecs) { slowestSecs = secs; slowestPace = p; }
    }
  }
  if (!slowestPace) return null;
  const spm = lookupSpm(slowestPace, paceSpm);
  return spm !== null ? { pace: slowestPace, spm } : null;
}

const TYPE_META: Record<WorkoutType, { label: string; color: string }> = {
  easy_run:  { label: "Easy Run",   color: "bg-green-500/20 text-green-400 border-green-500/30" },
  long_run:  { label: "Long Run",   color: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" },
  tempo:     { label: "Tempo",      color: "bg-orange-500/20 text-orange-400 border-orange-500/30" },
  interval:  { label: "Intervals",  color: "bg-red-500/20 text-red-400 border-red-500/30" },
  race:      { label: "Race",       color: "bg-red-600/20 text-red-300 border-red-500/30" },
  strength:  { label: "Strength",   color: "bg-slate-500/20 text-slate-400 border-slate-500/30" },
  other_run: { label: "Run",        color: "bg-blue-500/20 text-blue-400 border-blue-500/30" },
  rest:      { label: "Rest",       color: "bg-slate-700/20 text-slate-500 border-slate-700/30" },
};

const ZONE_COLORS = [
  "",
  "bg-emerald-500 text-black",
  "bg-green-500 text-black",
  "bg-yellow-500 text-black",
  "bg-orange-500 text-black",
  "bg-red-500 text-black",
];

const ZONE_NAMES = ["", "Warm Up", "Easy", "Aerobic", "Threshold", "Maximum"];

function formatDuration(secs: number): string {
  if (!secs) return "";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h${m > 0 ? ` ${m}m` : ""}`;
  return `${m}m`;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

function isToday(dateStr: string): boolean {
  return dateStr === new Date().toISOString().slice(0, 10);
}

function isTomorrow(dateStr: string): boolean {
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  return dateStr === tomorrow;
}

function dayLabel(dateStr: string): string {
  if (isToday(dateStr)) return "Today";
  if (isTomorrow(dateStr)) return "Tomorrow";
  return formatDate(dateStr);
}

function isYesterday(dateStr: string): boolean {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  return dateStr === yesterday;
}

function pastDayLabel(dateStr: string): string {
  if (isToday(dateStr)) return "Today";
  if (isYesterday(dateStr)) return "Yesterday";
  return formatDate(dateStr);
}

// ── Shared data hook ──────────────────────────────────────────────────────────

interface RunnaData {
  workouts: RunnaWorkout[];
  pastRuns: RunnaPastRun[];
  loading: boolean;
  error: string | null;
}

let cached: RunnaData | null = null;
let fetchPromise: Promise<void> | null = null;

function useRunnaData(): RunnaData {
  const [data, setData] = useState<RunnaData>(
    cached ?? { workouts: [], pastRuns: [], loading: true, error: null }
  );

  useEffect(() => {
    if (cached) { setData(cached); return; }
    if (!fetchPromise) {
      fetchPromise = fetch("/api/runna/workouts")
        .then(r => r.json())
        .then((d: { workouts?: RunnaWorkout[]; pastRuns?: RunnaPastRun[]; error?: string }) => {
          if (d.error) throw new Error(d.error);
          cached = { workouts: d.workouts ?? [], pastRuns: d.pastRuns ?? [], loading: false, error: null };
        })
        .catch(e => {
          cached = { workouts: [], pastRuns: [], loading: false, error: e instanceof Error ? e.message : "Failed to load" };
        });
    }
    fetchPromise.then(() => { if (cached) setData(cached); });
  }, []);

  return data;
}

// ── Runna Summary Card (past 8 days) ─────────────────────────────────────────

export function RunnaSummaryCard() {
  const { pastRuns, loading, error } = useRunnaData();
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 overflow-hidden">
      <div className="px-5 py-4 border-b border-white/10">
        <h2 className="font-semibold flex items-center gap-2">
          <span className="text-base">✅</span> Runna Summary
        </h2>
        <p className="text-xs text-slate-500 mt-0.5">Last 8 days</p>
      </div>

      {loading && (
        <div className="divide-y divide-white/10">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="px-5 py-3 animate-pulse flex gap-3">
              <div className="w-16 h-4 bg-slate-800 rounded" />
              <div className="flex-1 h-4 bg-slate-800 rounded" />
              <div className="w-20 h-4 bg-slate-800 rounded" />
            </div>
          ))}
        </div>
      )}

      {error && <p className="px-5 py-4 text-sm text-red-400">{error}</p>}

      {!loading && !error && pastRuns.length === 0 && (
        <p className="px-5 py-4 text-sm text-slate-500">No completed runs in the last 8 days.</p>
      )}

      {!loading && !error && pastRuns.length > 0 && (
        <div className="divide-y divide-white/10">
          {pastRuns.map(run => {
            const meta = TYPE_META[run.type];
            const isOpen = expanded === run.uid;

            return (
              <div key={run.uid}>
                <button
                  onClick={() => setExpanded(isOpen ? null : run.uid)}
                  className="w-full px-5 py-3 flex items-center gap-3 text-left hover:bg-slate-800/40 transition-colors"
                >
                  <span className={`text-xs shrink-0 w-20 ${isToday(run.date) ? "text-green-400 font-semibold" : "text-slate-500"}`}>
                    {pastDayLabel(run.date)}
                  </span>

                  <span className="text-sm text-slate-200 flex-1 min-w-0 truncate">{run.title}</span>

                  {/* Actual stats */}
                  <span className="text-xs text-slate-400 shrink-0 tabular-nums">
                    {run.distanceMi ? `${run.distanceMi}mi` : ""}
                    {run.distanceMi && run.durationStr ? " · " : ""}
                    {run.durationStr ?? ""}
                  </span>

                  {run.avgPace && (
                    <span className="text-xs text-slate-500 shrink-0">{run.avgPace}</span>
                  )}

                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full border shrink-0 ${meta.color}`}>
                    {meta.label}
                  </span>

                  <span className="text-slate-600 text-xs shrink-0">{isOpen ? "▲" : "▼"}</span>
                </button>

                {isOpen && (
                  <div className="px-5 pb-4 pt-1 bg-slate-800/20 space-y-2">
                    {run.laps.length > 0 && (
                      <div className="space-y-0.5">
                        <p className="text-xs text-slate-500 font-medium mb-1">Laps</p>
                        {run.laps.map((lap, i) => (
                          <p key={i} className="text-xs text-slate-400">{lap}</p>
                        ))}
                      </div>
                    )}
                    {run.appUrl && (
                      <a
                        href={run.appUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-block text-xs text-green-400 hover:text-green-300 underline mt-1"
                        onClick={e => e.stopPropagation()}
                      >
                        View in Runna app ↗
                      </a>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Runna Schedule Card (upcoming) ────────────────────────────────────────────

interface AiDjTrack { uri: string; name: string; artist: string; startsAt: string; tempo: number; camelot: string | null; energy: number; }
interface AiDjTimelineSegment { segment: string; targetBpm: number; tracks: AiDjTrack[]; }
interface AiDjMixResponse { trackUris: string[]; totalSec: number; timeline: AiDjTimelineSegment[]; }

interface RunnaScheduleProps {
  garminConfigured?: boolean;
  onPaceFilter?: (paceStr: string, bpm: number, multiSelect: boolean) => void;
  activePaces?: string[];
  aiDjEnabled?: boolean;
  /** Called once a mix is built — the parent populates the central track list/save UI rather than saving directly */
  onAiDjMix?: (workoutTitle: string, playlistName: string, tracks: TrackWithBPM[], totalSec: number) => void;
}

type MixStatus = { status: "building" | "done" | "error"; error?: string };

// "2026-07-08" + "Steady into Tempo" -> "08-07-26 Steady into Tempo"
function mixName(w: RunnaWorkout): string {
  const [y, m, d] = w.date.split("-");
  return `${d}-${m}-${y.slice(2)} ${w.title}`;
}

// ── Similar past routes (from GarminDB) ──────────────────────────────────────

interface RouteActivity {
  activity_id: number | string;
  name: string | null;
  start_time: string;
  distance: number;
  elapsed_time: string | number | null;
  avg_hr: number | null;
}

function parseDurationSecs(v: string | number | null): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v;
  const parts = v.split(":").map(Number);
  if (parts.some(isNaN)) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function routePace(a: RouteActivity): string | null {
  const secs = parseDurationSecs(a.elapsed_time);
  if (!secs || !a.distance) return null;
  const spm = secs / a.distance;
  return `${Math.floor(spm / 60)}:${String(Math.round(spm % 60)).padStart(2, "0")}/mi`;
}

function routeDate(a: RouteActivity): string {
  const d = new Date(a.start_time.slice(0, 19).replace(" ", "T"));
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function RunnaScheduleCard({ garminConfigured = false, onPaceFilter, activePaces = [], aiDjEnabled = false, onAiDjMix }: RunnaScheduleProps = {}) {
  const { workouts, loading, error } = useRunnaData();
  const [expanded, setExpanded] = useState<string | null>(null);
  const paceSpm = usePaceSpm(garminConfigured);
  const [mixState, setMixState] = useState<Record<string, MixStatus>>({});
  interface RoutePage { items: RouteActivity[]; offset: number; total: number; loading?: boolean }
  const [routes, setRoutes] = useState<Record<string, RoutePage>>({});
  const [routeMap, setRouteMap] = useState<{ id: string | number; label: string } | null>(null);

  function fetchRoutes(uid: string, distanceMi: number, offset: number) {
    setRoutes(r => ({ ...r, [uid]: { ...(r[uid] ?? { items: [], total: 0 }), offset, loading: true } }));
    fetch(`/api/garmin/similar-activities?distanceMi=${distanceMi}&offset=${offset}`)
      .then(res => res.json())
      .then((d: { activities?: RouteActivity[]; total?: number }) => {
        setRoutes(r => ({ ...r, [uid]: { items: d.activities ?? [], offset, total: d.total ?? 0 } }));
      })
      .catch(() => setRoutes(r => ({ ...r, [uid]: { items: [], offset, total: 0 } })));
  }

  // On expand, fetch past runs at (workout distance … +0.5mi) as route options
  useEffect(() => {
    if (!expanded || !garminConfigured) return;
    const w = workouts.find(x => x.uid === expanded);
    if (!w || !w.distanceMi || w.type === "strength" || w.type === "rest") return;
    if (routes[w.uid] !== undefined) return;
    fetchRoutes(w.uid, w.distanceMi, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, garminConfigured, workouts]);

  async function buildMix(w: RunnaWorkout) {
    setMixState(s => ({ ...s, [w.uid]: { status: "building" } }));
    try {
      const mixRes = await fetch("/api/ai-dj/mix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: w.title, segments: w.segments }),
      });
      const mix = await mixRes.json() as AiDjMixResponse & { error?: string };
      if (!mixRes.ok) throw new Error(mix.error ?? `Mix failed (${mixRes.status})`);
      if (!mix.trackUris?.length) throw new Error("No tracks matched this workout");

      const tracks: TrackWithBPM[] = mix.timeline.flatMap(seg => seg.tracks).map(t => ({
        id: t.uri.split(":")[2] ?? t.uri,
        name: t.name,
        artists: [{ name: t.artist }],
        album: { name: "", images: [] },
        duration_ms: 0,
        uri: t.uri,
        bpm: Math.round(t.tempo),
        energy: t.energy,
      }));

      onAiDjMix?.(w.title, mixName(w), tracks, mix.totalSec);
      setMixState(s => ({ ...s, [w.uid]: { status: "done" } }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to build mix";
      setMixState(s => ({ ...s, [w.uid]: { status: "error", error: msg } }));
    }
  }

  return (
    <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 overflow-hidden">
      <div className="px-5 py-4 border-b border-white/10">
        <h2 className="font-semibold flex items-center gap-2">
          <span className="text-base">🏃</span> Runna Schedule
        </h2>
        <p className="text-xs text-slate-500 mt-0.5">Next 4 weeks</p>
      </div>

      {loading && (
        <div className="divide-y divide-white/10">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="px-5 py-3 animate-pulse flex gap-3">
              <div className="w-16 h-4 bg-slate-800 rounded" />
              <div className="flex-1 h-4 bg-slate-800 rounded" />
              <div className="w-12 h-4 bg-slate-800 rounded" />
            </div>
          ))}
        </div>
      )}

      {error && <p className="px-5 py-4 text-sm text-red-400">{error}</p>}

      {!loading && !error && workouts.length === 0 && (
        <p className="px-5 py-4 text-sm text-slate-500">No upcoming workouts found.</p>
      )}

      {!loading && !error && workouts.length > 0 && (
        <div className="overflow-y-auto max-h-[600px] no-scrollbar divide-y divide-white/10">
          {workouts.map(w => {
            const meta = TYPE_META[w.type];
            const isOpen = expanded === w.uid;
            const isRun = w.type !== "strength" && w.type !== "rest";

            return (
              <div key={w.uid}>
                <button
                  onClick={() => setExpanded(isOpen ? null : w.uid)}
                  className="w-full px-5 py-3 flex items-center gap-3 text-left hover:bg-slate-800/40 transition-colors"
                >
                  <span className={`text-xs shrink-0 w-20 ${isToday(w.date) ? "text-green-400 font-semibold" : "text-slate-500"}`}>
                    {dayLabel(w.date)}
                  </span>

                  <span className="text-sm text-slate-200 flex-1 min-w-0 truncate">{w.title}</span>

                  {isRun && (
                    <span className="text-xs text-slate-500 shrink-0">
                      {w.distanceMi ? `${w.distanceMi}mi` : ""}
                      {w.distanceMi && w.durationSec ? " · " : ""}
                      {w.durationSec ? formatDuration(w.durationSec) : ""}
                    </span>
                  )}
                  {!isRun && w.durationSec > 0 && (
                    <span className="text-xs text-slate-500 shrink-0">{formatDuration(w.durationSec)}</span>
                  )}

                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full border shrink-0 ${meta.color}`}>
                    {meta.label}
                  </span>

                  {w.suggestedZone !== null && (
                    <span className={`text-xs font-bold px-2 py-0.5 rounded shrink-0 ${ZONE_COLORS[w.suggestedZone]}`}>
                      Z{w.suggestedZone} {ZONE_NAMES[w.suggestedZone]}
                    </span>
                  )}

                  <span className="text-slate-600 text-xs shrink-0">{isOpen ? "▲" : "▼"}</span>
                </button>

                {isOpen && (
                  <div className="px-5 pb-4 pt-1 bg-slate-800/20 space-y-2">
                    <div className="space-y-1">
                      {w.segments.map((seg, i) => (
                        <p key={i} className="text-xs text-slate-400 leading-relaxed">{seg}</p>
                      ))}
                    </div>
                    {w.appUrl && (
                      <a
                        href={w.appUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-block text-xs text-green-400 hover:text-green-300 underline mt-1"
                        onClick={e => e.stopPropagation()}
                      >
                        View in Runna app ↗
                      </a>
                    )}
                    {garminConfigured && onPaceFilter && paceSpm.length > 0 && (() => {
                      let withSpm = parsePacesFromSegments(w.segments)
                        .map(p => ({ pace: p, spm: lookupSpm(p, paceSpm) }))
                        .filter((x): x is { pace: string; spm: number } => x.spm !== null);
                      if (withSpm.length === 0 && w.segments.some(s => /conversational/i.test(s))) {
                        const fallback = findEasyRunPace(workouts, paceSpm);
                        if (fallback) withSpm = [fallback];
                      }
                      if (!withSpm.length) return null;
                      return (
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {withSpm.map(({ pace, spm }) => {
                            const isActive = activePaces.includes(pace);
                            return (
                              <button
                                key={pace}
                                onClick={e => { e.stopPropagation(); onPaceFilter(pace, spm, e.ctrlKey || e.metaKey); }}
                                className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${
                                  isActive
                                    ? "bg-orange-500/40 border-orange-400 text-orange-100"
                                    : "bg-orange-500/15 border-orange-500/30 text-orange-300 hover:bg-orange-500/25"
                                }`}
                              >
                                {pace} · {spm} BPM
                              </button>
                            );
                          })}
                        </div>
                      );
                    })()}
                    {aiDjEnabled && isRun && w.segments.length > 0 && (() => {
                      const st = mixState[w.uid];
                      return (
                        <div className="flex flex-wrap items-center gap-2 pt-1">
                          <button
                            onClick={e => { e.stopPropagation(); if (st?.status !== "building") buildMix(w); }}
                            disabled={st?.status === "building"}
                            className="text-xs px-2.5 py-1 rounded-lg border bg-purple-500/15 border-purple-500/30 text-purple-300 hover:bg-purple-500/25 disabled:opacity-60 disabled:cursor-wait transition-colors"
                          >
                            {st?.status === "building" ? "🎧 Mixing…" : st?.status === "done" ? "🎧 Remix" : "🎧 AI DJ Mix"}
                          </button>
                          {st?.status === "building" && (
                            <span className="text-xs text-slate-500">Building pace-matched playlist…</span>
                          )}
                          {st?.status === "done" && (
                            <span className="text-xs text-purple-300/80">Loaded into the track list — review &amp; save from there ↑</span>
                          )}
                          {st?.status === "error" && (
                            <span className="text-xs text-red-400">{st.error}</span>
                          )}
                        </div>
                      );
                    })()}
                    {garminConfigured && isRun && w.distanceMi && (() => {
                      const r = routes[w.uid];
                      if (!r || r.total === 0) return null;
                      const canNewer = r.offset > 0;
                      const canOlder = r.offset + 3 < r.total;
                      const pagerBtn = "px-1.5 py-1 rounded-lg border border-white/10 text-slate-400 hover:text-sky-300 hover:border-sky-500/30 disabled:opacity-25 disabled:hover:text-slate-400 disabled:hover:border-white/10 transition-colors text-xs shrink-0";
                      return (
                        <div className="pt-1 space-y-1.5">
                          <p className="text-xs text-slate-500">
                            Routes at this distance ({w.distanceMi}–{(w.distanceMi + 0.5).toFixed(1)}mi) · {r.offset + 1}–{Math.min(r.offset + 3, r.total)} of {r.total}
                          </p>
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={e => { e.stopPropagation(); if (canNewer) fetchRoutes(w.uid, w.distanceMi!, Math.max(0, r.offset - 3)); }}
                              disabled={!canNewer || r.loading}
                              className={pagerBtn}
                              title="Newer runs"
                            >
                              &lt;
                            </button>
                            <div className={`flex flex-nowrap gap-1.5 flex-1 min-w-0 ${r.loading ? "opacity-50" : ""}`}>
                              {r.items.map(a => (
                                <button
                                  key={a.activity_id}
                                  onClick={e => {
                                    e.stopPropagation();
                                    setRouteMap({
                                      id: a.activity_id,
                                      label: `${routeDate(a)} · ${a.distance.toFixed(1)}mi`,
                                    });
                                  }}
                                  className="flex-1 min-w-0 truncate whitespace-nowrap text-center text-xs px-1.5 py-1 rounded-lg border bg-sky-500/15 border-sky-500/30 text-sky-300 hover:bg-sky-500/25 transition-colors"
                                  title={a.name ?? undefined}
                                >
                                  {routeDate(a)} · {a.distance.toFixed(1)}mi{routePace(a) ? ` · ${routePace(a)!.replace("/mi", "")}` : ""}
                                </button>
                              ))}
                            </div>
                            <button
                              onClick={e => { e.stopPropagation(); if (canOlder) fetchRoutes(w.uid, w.distanceMi!, r.offset + 3); }}
                              disabled={!canOlder || r.loading}
                              className={pagerBtn}
                              title="Older runs"
                            >
                              &gt;
                            </button>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {routeMap && (
        <RouteMapLightbox
          activityId={routeMap.id}
          label={routeMap.label}
          onClose={() => setRouteMap(null)}
        />
      )}
    </div>
  );
}

// Legacy export so any existing import still compiles
export { RunnaScheduleCard as RunnaCard };
