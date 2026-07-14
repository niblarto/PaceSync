"use client";

import { useState, useEffect, useMemo, useRef, forwardRef, useImperativeHandle } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { freshSpotifyToken } from "@/lib/spotify-browser";
import type { RunnaWorkout, RunnaPastRun, WorkoutType } from "@/app/api/runna/workouts/route";
import type { TrackWithBPM } from "@/types";
import { RouteMapLightbox } from "./RouteMapLightbox";
import { openInSpotify } from "./TrackRow";
import { useRunningPlaylist } from "./useRunningPlaylist";

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
  strength:  { label: "Strength",   color: "bg-amber-500/20 text-amber-400 border-amber-500/30" },
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

interface PacingTrack {
  uri: string | null;
  name: string;
  artist: string;
  segment: string;
  targetPaceSec: number | null;
  actualPaceSec: number | null;
  verdict: "on" | "fast" | "slow" | "unknown";
  inLibrary?: boolean; // false once the track has been deleted from the library
}
interface PacingState {
  loading: boolean;
  tracks: PacingTrack[];
  summary: string | null;
  none?: boolean;
  workoutTitle?: string;
  approved?: boolean; // undefined = not yet reviewed, false = disputed
}

const PACING_STYLE: Record<PacingTrack["verdict"], string> = {
  on: "bg-green-500/10 border-green-500/30 text-green-300",
  fast: "bg-red-500/10 border-red-500/30 text-red-300",
  slow: "bg-sky-500/10 border-sky-500/30 text-sky-300",
  unknown: "bg-slate-800/40 border-white/5 text-slate-500",
};

function fmtPaceSec(s: number | null): string {
  if (!s) return "—";
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}

export function RunnaSummaryCard() {
  const { pastRuns, loading, error } = useRunnaData();
  const [expanded, setExpanded] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pacing, setPacing] = useState<Record<string, PacingState>>({});
  const [activityLinks, setActivityLinks] = useState<Record<string, { garminId: string | number | null; stravaId: number | null } | null>>({});
  const [votes, setVotes] = useState<{ uri: string; paceSec: number; vote: "up" | "down" }[]>([]);
  const [votesLoaded, setVotesLoaded] = useState(false);
  const [deletedUris, setDeletedUris] = useState<Set<string>>(new Set());
  const { data: session } = useSession();
  const { id: RUNNING_PLAYLIST_ID } = useRunningPlaylist();
  const [titleSync, setTitleSync] = useState<Record<string, { status: "syncing" | "done" | "error"; message?: string }>>({});

  function retrySyncTitle(stravaId: number) {
    setTitleSync(s => ({ ...s, [stravaId]: { status: "syncing" } }));
    fetch("/api/strava/sync-title", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ activityId: stravaId }),
    })
      .then(r => r.json())
      .then((d: { error?: string; updated?: boolean; workoutTitle?: string; reason?: string }) => {
        if (d.error) {
          setTitleSync(s => ({ ...s, [stravaId]: { status: "error", message: d.error } }));
        } else if (d.updated) {
          setTitleSync(s => ({ ...s, [stravaId]: { status: "done", message: `Updated: "${d.workoutTitle}"` } }));
        } else {
          setTitleSync(s => ({ ...s, [stravaId]: { status: "error", message: d.reason ?? "No matching workout found" } }));
        }
      })
      .catch(e => setTitleSync(s => ({ ...s, [stravaId]: { status: "error", message: e instanceof Error ? e.message : "Retry failed" } })));
  }

  // Today's run appearing here means Runna has marked it complete — kick off
  // a GarminDB sync so its stats (and the pacing review below) are fresh
  // without waiting for the 15:00 cron. The route dedupes per day itself.
  const autoSyncTriggeredRef = useRef(false);
  useEffect(() => {
    if (autoSyncTriggeredRef.current || loading) return;
    const today = new Date().toISOString().slice(0, 10);
    if (!pastRuns.some(r => r.date === today)) return;
    autoSyncTriggeredRef.current = true;
    fetch("/api/garmin/auto-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: today }),
    }).catch(() => {});
  }, [pastRuns, loading]);

  function loadVotes() {
    if (votesLoaded) return;
    setVotesLoaded(true);
    fetch("/api/track-feedback")
      .then(r => r.json())
      .then((d: { votes?: { uri: string; paceSec: number; vote: "up" | "down" }[] }) => setVotes(d.votes ?? []))
      .catch(() => {});
  }

  function voteFor(t: PacingTrack): "up" | "down" | null {
    if (!t.uri || t.targetPaceSec == null) return null;
    const v = votes.find(v => v.uri === t.uri && Math.abs(v.paceSec - (t.targetPaceSec as number)) <= 10);
    return v?.vote ?? null;
  }

  function castVote(t: PacingTrack, vote: "up" | "down") {
    if (!t.uri || t.targetPaceSec == null) return;
    const next = voteFor(t) === vote ? null : vote;
    fetch("/api/track-feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uri: t.uri, paceSec: t.targetPaceSec, vote: next }),
    })
      .then(r => r.json())
      .then((d: { votes?: { uri: string; paceSec: number; vote: "up" | "down" }[] }) => { if (d.votes) setVotes(d.votes); })
      .catch(() => {});
  }

  // Same delete as the dashboard/activity page: Spotify Running playlist +
  // library CSV; the row stays struck through as a record of what played.
  function deleteTrack(t: PacingTrack) {
    if (!t.uri) return;
    const uri = t.uri;
    setDeletedUris(prev => { const next = new Set(Array.from(prev)); next.add(uri); return next; });
    if (RUNNING_PLAYLIST_ID) {
      freshSpotifyToken().then(token => {
        if (!token) return;
        return fetch(`https://api.spotify.com/v1/playlists/${RUNNING_PLAYLIST_ID}/items`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ items: [{ uri }] }),
        });
      }).catch(err => console.error("[delete] Spotify fetch error:", err));
    }
    fetch("/api/tracks/delete", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spotifyUri: uri }),
    }).catch(() => {});
  }

  function fetchPacing(date: string, force = false) {
    if (pacing[date] && !force) return;
    setPacing(p => ({ ...p, [date]: { loading: true, tracks: [], summary: null } }));
    fetch(`/api/garmin/run-pacing?date=${date}`)
      .then(r => r.json())
      .then((d: { entry?: { workoutTitle?: string; approved?: boolean } | null; tracks?: PacingTrack[]; summary?: string | null; error?: string }) => {
        setPacing(p => ({
          ...p,
          [date]: {
            loading: false,
            tracks: d.tracks ?? [],
            summary: d.summary ?? null,
            none: !d.entry || (!(d.tracks?.length) && d.entry.approved !== false),
            workoutTitle: d.entry?.workoutTitle,
            approved: d.entry?.approved,
          },
        }));
      })
      .catch(() => setPacing(p => ({ ...p, [date]: { loading: false, tracks: [], summary: null, none: true } })));
  }

  function fetchActivityLinks(date: string) {
    if (activityLinks[date] !== undefined) return;
    setActivityLinks(l => ({ ...l, [date]: null }));
    fetch(`/api/garmin/activity-for-date?date=${date}`)
      .then(r => r.json())
      .then((d: { garminId?: string | number | null; stravaId?: number | null }) => {
        setActivityLinks(l => ({ ...l, [date]: { garminId: d.garminId ?? null, stravaId: d.stravaId ?? null } }));
      })
      .catch(() => setActivityLinks(l => ({ ...l, [date]: { garminId: null, stravaId: null } })));
  }

  const [approving, setApproving] = useState<string | null>(null);
  function setApproval(date: string, approved: boolean) {
    setApproving(date);
    fetch("/api/todays-run/history", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date, approved }),
    })
      .then(r => r.json())
      .then((d: { error?: string }) => {
        if (d.error) return;
        fetchPacing(date, true);
      })
      .finally(() => setApproving(a => (a === date ? null : a)));
  }

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
        <div ref={scrollRef} className="overflow-y-auto max-h-[700px] no-scrollbar divide-y divide-white/10">
          {pastRuns.map(run => {
            const meta = TYPE_META[run.type];
            const isOpen = expanded === run.uid;

            return (
              <div key={run.uid}>
                <button
                  onClick={e => {
                    setExpanded(isOpen ? null : run.uid);
                    if (!isOpen) {
                      fetchPacing(run.date); loadVotes(); fetchActivityLinks(run.date);
                      const row = e.currentTarget.parentElement as HTMLElement | null;
                      const container = scrollRef.current;
                      // Scroll only the card's own list container — never
                      // scrollIntoView, which can also move the outer page
                      // scroll. Computed after the expanding content lays
                      // out, so the row lands at the container's top rather
                      // than wherever it sat before expansion.
                      requestAnimationFrame(() => {
                        if (!row || !container) return;
                        container.scrollTo({ top: row.offsetTop - container.offsetTop, behavior: "smooth" });
                      });
                    }
                  }}
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
                    {(() => {
                      const links = activityLinks[run.date];
                      if (!run.appUrl && (!links || (!links.garminId && !links.stravaId))) return null;
                      const sync = links?.stravaId ? titleSync[links.stravaId] : undefined;
                      return (
                        <>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                          {run.appUrl && (
                            <a
                              href={run.appUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-green-400 hover:text-green-300 underline"
                              onClick={e => e.stopPropagation()}
                            >
                              View in Runna app ↗
                            </a>
                          )}
                          {links?.garminId && (
                            <>
                              <Link
                                href={`/garmin/activity/${links.garminId}`}
                                className="text-sky-400 hover:text-sky-300 underline"
                              >
                                Garmin activity ↗
                              </Link>
                              <a
                                href={`https://connect.garmin.com/modern/activity/${links.garminId}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-sky-400 hover:text-sky-300 underline"
                              >
                                Garmin Connect ↗
                              </a>
                            </>
                          )}
                          {links?.stravaId && (
                            <a
                              href={`https://www.strava.com/activities/${links.stravaId}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-orange-400 hover:text-orange-300 underline"
                            >
                              Strava ↗
                            </a>
                          )}
                          {links?.stravaId && (
                            <button
                              onClick={e => { e.stopPropagation(); retrySyncTitle(links.stravaId!); }}
                              disabled={sync?.status === "syncing"}
                              className="text-orange-400/80 hover:text-orange-300 underline disabled:opacity-50 disabled:cursor-wait"
                              title="Re-check Runna and update the Strava title/description if it's still missing"
                            >
                              {sync?.status === "syncing" ? "Syncing title…" : "Sync Strava title"}
                            </button>
                          )}
                        </div>
                        {sync && sync.status !== "syncing" && sync.message && (
                          <p className={`text-xs ${sync.status === "done" ? "text-green-400" : "text-red-400"}`}>
                            {sync.message}
                          </p>
                        )}
                        </>
                      );
                    })()}
                    {run.laps.length > 0 && (
                      <div className="space-y-0.5">
                        <p className="text-xs text-slate-500 font-medium mb-1">Laps</p>
                        {run.laps.map((lap, i) => (
                          <p key={i} className="text-xs text-slate-400">{lap}</p>
                        ))}
                      </div>
                    )}
                    {run.planSteps.length > 0 && (
                      <div className="space-y-0.5">
                        <p className="text-xs text-slate-500 font-medium mb-1">Workout</p>
                        {run.planSteps.map((step, i) => (
                          <p
                            key={i}
                            className={`text-xs text-slate-400 ${step.startsWith("•") ? "pl-3" : "pt-1 first:pt-0"}`}
                          >
                            {step}
                          </p>
                        ))}
                      </div>
                    )}
                    {(() => {
                      const pd = pacing[run.date];
                      if (!pd) return null;
                      if (pd.loading) return <p className="text-xs text-slate-600">Loading mix pacing…</p>;

                      if (pd.approved === false) {
                        return (
                          <p className="text-xs text-slate-500 italic">
                            You said this wasn&apos;t the playlist you ran to — pacing not compared.{" "}
                            <button
                              onClick={() => setApproval(run.date, true)}
                              disabled={approving === run.date}
                              className="not-italic text-sky-400 hover:text-sky-300 underline disabled:opacity-40"
                            >
                              Undo
                            </button>
                          </p>
                        );
                      }

                      if (pd.none || pd.tracks.length === 0) return null;

                      return (
                        <div className="space-y-1">
                          {pd.approved === undefined && (
                            <div className="flex items-center gap-2 text-xs bg-amber-500/10 border border-amber-500/30 text-amber-300 rounded px-2 py-1.5">
                              <span className="flex-1">Did you actually listen to this playlist on this run?</span>
                              <button
                                onClick={() => setApproval(run.date, true)}
                                disabled={approving === run.date}
                                className="rounded bg-amber-500/20 hover:bg-amber-500/30 disabled:opacity-40 px-2 py-0.5 font-medium transition-colors"
                              >
                                Yes
                              </button>
                              <button
                                onClick={() => setApproval(run.date, false)}
                                disabled={approving === run.date}
                                className="rounded bg-slate-700/50 hover:bg-slate-700/80 disabled:opacity-40 px-2 py-0.5 font-medium transition-colors"
                              >
                                No, discard
                              </button>
                            </div>
                          )}
                          <p className="text-xs text-slate-500 font-medium mb-1">
                            🎧 &quot;Today&apos;s Run&quot; mix vs actual pace
                            <span className="ml-2 font-normal text-slate-600">
                              green = on pace · red = too fast · blue = too slow
                            </span>
                          </p>
                          <div className="space-y-1 max-h-56 overflow-y-auto pr-1">
                            {pd.tracks.map((t, i) => {
                              const v = voteFor(t);
                              const isDeleted = t.uri !== null && (deletedUris.has(t.uri) || t.inLibrary === false);
                              return (
                                <div
                                  key={i}
                                  className={`flex items-center gap-2 text-xs rounded border px-2 py-1 ${PACING_STYLE[t.verdict]} ${isDeleted ? "opacity-40 line-through" : ""}`}
                                  title={t.segment}
                                >
                                  {t.uri ? (
                                    <button
                                      onClick={() => openInSpotify(t.uri!)}
                                      className="flex-1 min-w-0 truncate text-left hover:underline"
                                      title={`${t.name} — open in Spotify`}
                                    >
                                      {t.name} — {t.artist}
                                    </button>
                                  ) : (
                                    <span className="flex-1 min-w-0 truncate">{t.name} — {t.artist}</span>
                                  )}
                                  <span className="shrink-0 tabular-nums" title="actual / target pace per mile">
                                    {fmtPaceSec(t.actualPaceSec)}
                                    {t.targetPaceSec ? ` / ${fmtPaceSec(t.targetPaceSec)}` : ""}
                                  </span>
                                  {t.uri && t.targetPaceSec != null && !isDeleted && (
                                    <span className="flex items-center gap-1 shrink-0 ml-1">
                                      <button
                                        onClick={() => castVote(t, "up")}
                                        className={`px-1 rounded transition-all ${v === "up" ? "opacity-100 scale-110 bg-green-500/20" : "opacity-35 hover:opacity-80"}`}
                                        title="Play this more often at this pace"
                                      >
                                        👍
                                      </button>
                                      <button
                                        onClick={() => castVote(t, "down")}
                                        className={`px-1 rounded transition-all ${v === "down" ? "opacity-100 scale-110 bg-red-500/20" : "opacity-35 hover:opacity-80"}`}
                                        title="Exclude from runs at this pace"
                                      >
                                        👎
                                      </button>
                                      <button
                                        onClick={() => deleteTrack(t)}
                                        className="px-1 rounded opacity-35 hover:opacity-100 hover:text-red-400 transition-all"
                                        title="Delete from the Running playlist and library"
                                      >
                                        🗑
                                      </button>
                                    </span>
                                  )}
                                  {isDeleted && <span className="shrink-0 ml-1 text-slate-500 no-underline">deleted</span>}
                                </div>
                              );
                            })}
                          </div>
                          {pd.summary && <p className="text-xs text-slate-400 mt-1">{pd.summary}</p>}
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
    </div>
  );
}

// ── Runna Schedule Card (upcoming) ────────────────────────────────────────────

interface AiDjTrack { uri: string; name: string; artist: string; startsAt: string; durationSec?: number; tempo: number; camelot: string | null; energy: number; }
interface AiDjTimelineSegment { segment: string; targetBpm: number | null; targetPaceSec?: number | null; tracks: AiDjTrack[]; }
interface AiDjMixResponse { trackUris: string[]; totalSec: number; timeline: AiDjTimelineSegment[]; }
export type AiDjTimeline = AiDjTimelineSegment[];

interface RunnaScheduleProps {
  garminConfigured?: boolean;
  onPaceFilter?: (paceStr: string, bpm: number, multiSelect: boolean) => void;
  activePaces?: string[];
  aiDjEnabled?: boolean;
  /** Called once a mix is built — the parent populates the central track list/save UI rather than saving directly */
  onAiDjMix?: (workoutTitle: string, playlistName: string, tracks: TrackWithBPM[], totalSec: number, segments: string[], date: string, timeline: AiDjTimelineSegment[], avoidUris?: string[]) => void;
  /** Bumped by the parent after a mix is saved — invalidates the saved-mix tracklist cache */
  mixSavedNonce?: number;
}

// Exposed to the parent so the tracks card's Remix button can drive this
// card's own progress bar/LLM detail line instead of building the mix
// silently — the workout is looked up by date since that's what the
// tracks card's aiDjMix state carries.
export interface RunnaScheduleHandle {
  remix: (date: string, avoidUris: string[]) => Promise<void>;
}

// Strength sessions have no pace segments — synthesize one the mixer's
// strength kind understands (high energy, any BPM, session-length budget).
// durationSec comes straight from Runna's ICS estimate, which is occasionally
// missing/wrong for strength sessions — clamp to a sane range so a bad value
// can't produce a runaway-length mix.
const STRENGTH_MIN_SEC = 10 * 60;
const STRENGTH_MAX_SEC = 90 * 60;
function mixSegmentsFor(w: RunnaWorkout): string[] {
  if (w.type !== "strength") return w.segments;
  const raw = w.durationSec;
  const clamped = Math.min(Math.max(raw || 45 * 60, STRENGTH_MIN_SEC), STRENGTH_MAX_SEC);
  if (raw !== clamped) {
    console.warn(`[ai-dj] strength duration ${raw}s out of range — using ${clamped}s`);
  }
  const mins = Math.round(clamped / 60);
  // The "•"-delimited summary line lets the mixer's max_projected_duration
  // parse this as the workout's target length (same as a run's card summary,
  // e.g. "Long Run • 13.1mi • 1h50m - 2h10m") — without it, the mixer falls
  // back to a fixed +5min pad, which let strength mixes run well past the
  // stated session length (a 45min target became a 60min playlist).
  return [`Strength • ${mins}m - ${mins}m`, `${mins} min strength session`];
}

type MixProgress = { current: number; total: number; segment: string; detail?: string };
type MixStatus = { status: "building" | "done" | "error"; error?: string; warning?: string; startedAt?: number; progress?: MixProgress; uris?: string[] };

// Real per-segment progress streamed over SSE from /api/ai-dj/mix. Between
// segment events the bar eases partway toward the next step (a segment's LLM
// pick can take ~30s), so it never looks stalled. Falls back to a pure
// time-based curve if no progress events arrive (older AI DJ service).
function MixProgressBar({ startedAt, progress }: { startedAt: number; progress?: MixProgress }) {
  const [, forceTick] = useState(0);
  const stepStartRef = useRef(startedAt);
  const lastStepRef = useRef(-1);
  useEffect(() => {
    const t = setInterval(() => forceTick(n => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  if (progress && progress.current !== lastStepRef.current) {
    lastStepRef.current = progress.current;
    stepStartRef.current = Date.now();
  }
  const elapsedSec = (Date.now() - startedAt) / 1000;
  let pct: number;
  if (progress) {
    // Ease up to 90% of the current step's width while it builds
    const stepFrac = Math.min(0.9, ((Date.now() - stepStartRef.current) / 1000 / 30) * 0.9);
    pct = Math.min(98, ((progress.current + stepFrac) / progress.total) * 100);
  } else {
    pct = Math.min(95, 100 * (1 - Math.exp(-elapsedSec / 45)));
  }
  return (
    <div className="flex items-center gap-2 flex-1 min-w-[140px] max-w-[280px]">
      <div className="flex-1 h-1.5 rounded-full bg-slate-800 overflow-hidden">
        <div
          className="h-full rounded-full bg-purple-400 transition-[width] duration-500 ease-linear"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-slate-500 tabular-nums shrink-0">
        {progress ? `${Math.min(progress.current + 1, progress.total)}/${progress.total} · ` : ""}{Math.floor(elapsedSec)}s
      </span>
    </div>
  );
}

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

// ── Garmin Connect courses ────────────────────────────────────────────────────

interface GarminCourse {
  id: number;
  name: string;
  distanceMi: number;
  createdDate: number;
}

// ── Run-time weather (Met Office) ─────────────────────────────────────────────

interface DayWeather {
  tempC: number;
  feelsLikeC: number;
  precipProb: number;
  windMph: number;
  description: string;
  emoji: string;
  sampledAt: string;
}

// True if the course title contains the workout's date in any of the formats
// used in course names: "11-07-26", "11-07-2026", "110726", "11.07.26".
function courseMatchesDate(name: string, date: string): boolean {
  const [y, m, d] = date.split("-");
  const re = new RegExp(`(^|\\D)${d}[-/. ]?${m}[-/. ]?(?:${y}|${y.slice(2)})(\\D|$)`);
  return re.test(name);
}

export const RunnaScheduleCard = forwardRef<RunnaScheduleHandle, RunnaScheduleProps>(function RunnaScheduleCard(
  { garminConfigured = false, onPaceFilter, activePaces = [], aiDjEnabled = false, onAiDjMix, mixSavedNonce = 0 }: RunnaScheduleProps = {},
  ref,
) {
  const { workouts: allWorkouts, pastRuns, loading, error } = useRunnaData();
  // Once a workout is completed, Runna surfaces it on the Summary card
  // (pastRuns) instead — drop it here so the same day's run isn't shown as
  // both upcoming (Schedule) and completed (Summary) at once.
  const workouts = useMemo(
    () => allWorkouts.filter(w => !pastRuns.some(r => r.date === w.date)),
    [allWorkouts, pastRuns],
  );
  const [expanded, setExpanded] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const paceSpm = usePaceSpm(garminConfigured);
  const [mixState, setMixState] = useState<Record<string, MixStatus>>({});
  interface RoutePage { items: RouteActivity[]; offset: number; total: number; loading?: boolean }
  const [routes, setRoutes] = useState<Record<string, RoutePage>>({});
  const [routeMap, setRouteMap] = useState<{ id: string | number; label: string } | null>(null);
  const [courses, setCourses] = useState<GarminCourse[] | null>(null);
  const [courseOffsets, setCourseOffsets] = useState<Record<string, number>>({});
  const [weather, setWeather] = useState<Record<string, DayWeather>>({});

  // Run-time weather for the week ahead — one fetch covers every card.
  useEffect(() => {
    fetch("/api/weather")
      .then(r => r.json())
      .then((d: { days?: Record<string, DayWeather> }) => setWeather(d.days ?? {}))
      .catch(() => {});
  }, []);

  function fetchRoutes(uid: string, distanceMi: number, offset: number) {
    setRoutes(r => ({ ...r, [uid]: { ...(r[uid] ?? { items: [], total: 0 }), offset, loading: true } }));
    fetch(`/api/garmin/similar-activities?distanceMi=${distanceMi}&offset=${offset}`)
      .then(res => res.json())
      .then((d: { activities?: RouteActivity[]; total?: number }) => {
        setRoutes(r => ({ ...r, [uid]: { items: d.activities ?? [], offset, total: d.total ?? 0 } }));
      })
      .catch(() => setRoutes(r => ({ ...r, [uid]: { items: [], offset, total: 0 } })));
  }

  // On expand, show the saved AI DJ mix for this workout's date (pre-built by
  // the nightly cron or saved from the dashboard) — keyed by workout date.
  interface MixSnapshot { workoutTitle: string; tracks: { uri: string | null; name: string; artist: string; startsAtSec: number; tempo: number | null }[]; pinned?: boolean }
  const [mixSnapshots, setMixSnapshots] = useState<Record<string, MixSnapshot | null>>({});
  const [unpinningDate, setUnpinningDate] = useState<string | null>(null);
  const [pinningDate, setPinningDate] = useState<string | null>(null);
  const [deletingDate, setDeletingDate] = useState<string | null>(null);

  async function unpinMix(date: string) {
    setUnpinningDate(date);
    try {
      // Server-side, unpinning deletes the mix outright (both the pin and
      // the underlying "Today's Run" history snapshot) rather than leaving
      // it around as an unpinned "saved" mix.
      await fetch("/api/ai-dj/pin", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date }),
      });
      setMixSnapshots(s => ({ ...s, [date]: null }));
    } finally {
      setUnpinningDate(null);
    }
  }

  async function repinMix(date: string) {
    setPinningDate(date);
    try {
      // No timeline in the body — the pin route re-pins from the existing
      // "Today's Run" history entry for this date as-is.
      await fetch("/api/ai-dj/pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date }),
      });
      setMixSnapshots(s => (s[date] ? { ...s, [date]: { ...s[date]!, pinned: true } } : s));
    } finally {
      setPinningDate(null);
    }
  }

  async function deleteSavedMix(date: string) {
    setDeletingDate(date);
    try {
      await fetch("/api/todays-run/history", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date }),
      });
      setMixSnapshots(s => ({ ...s, [date]: null }));
    } finally {
      setDeletingDate(null);
    }
  }

  // A save on the dashboard bumps mixSavedNonce — drop the cache so the
  // fetch effect below (which depends on mixSnapshots) re-reads fresh data.
  useEffect(() => {
    if (mixSavedNonce > 0) setMixSnapshots({});
  }, [mixSavedNonce]);

  useEffect(() => {
    if (!expanded || !aiDjEnabled) return;
    const w = workouts.find(x => x.uid === expanded);
    if (!w || w.type === "rest") return;
    if (mixSnapshots[w.date] !== undefined) return;
    fetch(`/api/todays-run/history?date=${w.date}`)
      .then(r => r.json())
      .then((d: { entry?: MixSnapshot | null }) => {
        setMixSnapshots(s => ({ ...s, [w.date]: d.entry ?? null }));
      })
      .catch(() => setMixSnapshots(s => ({ ...s, [w.date]: null })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, aiDjEnabled, workouts, mixSnapshots]);

  // On expand, fetch past runs at (workout distance … +0.5mi) as route options
  useEffect(() => {
    if (!expanded || !garminConfigured) return;
    const w = workouts.find(x => x.uid === expanded);
    if (!w || !w.distanceMi || w.type === "strength" || w.type === "rest") return;
    if (routes[w.uid] !== undefined) return;
    fetchRoutes(w.uid, w.distanceMi, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, garminConfigured, workouts]);

  // Garmin Connect course library — fetched once, filtered per card below.
  useEffect(() => {
    if (!expanded || !garminConfigured || courses !== null) return;
    const w = workouts.find(x => x.uid === expanded);
    if (!w || !w.distanceMi || w.type === "strength" || w.type === "rest") return;
    fetch("/api/garmin/courses")
      .then(r => r.json())
      .then((d: { courses?: GarminCourse[] }) => setCourses(d.courses ?? []))
      .catch(() => setCourses([]));
  }, [expanded, garminConfigured, workouts, courses]);

  async function buildMix(w: RunnaWorkout, seedAvoidUris?: string[]) {
    // A remix should sound different: send the previous build's tracks so the
    // mixer demotes them (they only reappear if the BPM pool runs dry). On
    // the very first remix of a session (no in-session mix yet), seed from
    // the saved/pinned mix's tracks instead, so remixing a persisted mix
    // still avoids repeating it rather than rebuilding the same setlist.
    const avoidUris = mixState[w.uid]?.uris ?? seedAvoidUris;
    setMixState(s => ({ ...s, [w.uid]: { status: "building", startedAt: Date.now(), uris: avoidUris } }));
    try {
      const mixRes = await fetch("/api/ai-dj/mix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: w.title, segments: mixSegmentsFor(w), avoidUris }),
      });
      if (!mixRes.ok || !mixRes.body) {
        const err = await mixRes.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? `Mix failed (${mixRes.status})`);
      }

      // SSE: progress events per workout segment, then done/error
      let mix: AiDjMixResponse | null = null;
      const reader = mixRes.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const dataLine = chunk.split("\n").find(l => l.startsWith("data: "));
          if (!dataLine) continue;
          const msg = JSON.parse(dataLine.slice(6)) as
            & Partial<AiDjMixResponse>
            & { type: string; current?: number; total?: number; segment?: string; detail?: string; error?: string;
                count?: number; tracks?: string[]; fields?: string[]; llmFailures?: string[] };
          if (msg.type === "warning" && msg.llmFailures?.length) {
            // Segment(s) where the model call failed (rate limit, quota,
            // network) and fell back to the deterministic distance-chain —
            // the mix still built, but with less curated track selection.
            const n = msg.llmFailures.length;
            const warning = `⚠ ${n} segment${n === 1 ? "" : "s"} fell back to basic BPM matching (model call failed) — check Settings usage`;
            setMixState(s => ({ ...s, [w.uid]: { ...s[w.uid], status: "building", warning } }));
          } else if (msg.type === "warning") {
            // Library tracks missing data (duration/BPM/…) that couldn't be
            // backfilled — they're excluded from the mix pool.
            const names = (msg.tracks ?? []).join(", ");
            const extra = (msg.count ?? 0) > (msg.tracks?.length ?? 0) ? ` +${msg.count! - msg.tracks!.length} more` : "";
            const warning = `⚠ ${msg.count} track${msg.count === 1 ? "" : "s"} missing ${
              (msg.fields ?? []).join("/") || "data"} left out of the mix: ${names}${extra}`;
            setMixState(s => ({ ...s, [w.uid]: { ...s[w.uid], status: "building", warning } }));
          } else if (msg.type === "progress") {
            const progress = { current: msg.current ?? 0, total: msg.total ?? 1, segment: msg.segment ?? "", detail: msg.detail };
            setMixState(s => ({ ...s, [w.uid]: { ...s[w.uid], status: "building", progress } }));
          } else if (msg.type === "error") {
            throw new Error(msg.error ?? "Mix failed");
          } else if (msg.type === "done") {
            mix = { trackUris: msg.trackUris ?? [], totalSec: msg.totalSec ?? 0, timeline: msg.timeline ?? [] };
          }
        }
      }
      if (!mix) throw new Error("Mix stream ended without a result");
      if (!mix.trackUris?.length) throw new Error("No tracks matched this workout");

      const tracks: TrackWithBPM[] = mix.timeline.flatMap(seg => seg.tracks).map(t => ({
        id: t.uri.split(":")[2] ?? t.uri,
        name: t.name,
        artists: [{ name: t.artist }],
        album: { name: "", images: [] },
        duration_ms: Math.round((t.durationSec ?? 0) * 1000),
        uri: t.uri,
        bpm: Math.round(t.tempo),
        energy: t.energy,
      }));

      // Accumulate across remixes: avoiding only the latest build lets the
      // mixer alternate between the same two setlists.
      const accumulatedUris = Array.from(new Set([...(mixState[w.uid]?.uris ?? []), ...mix.trackUris]));
      onAiDjMix?.(w.title, mixName(w), tracks, mix.totalSec, mixSegmentsFor(w), w.date, mix.timeline, accumulatedUris);
      setMixState(s => ({
        ...s,
        [w.uid]: { status: "done", warning: s[w.uid]?.warning, uris: accumulatedUris },
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to build mix";
      setMixState(s => ({ ...s, [w.uid]: { status: "error", error: msg, warning: s[w.uid]?.warning } }));
    }
  }

  useImperativeHandle(ref, () => ({
    remix(date, avoidUris) {
      const w = workouts.find(x => x.date === date);
      if (!w) return Promise.resolve();
      setExpanded(w.uid);
      return buildMix(w, avoidUris);
    },
  }), [workouts]);

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
        <div ref={scrollRef} className="overflow-y-auto max-h-[700px] no-scrollbar divide-y divide-white/10">
          {workouts.map(w => {
            const meta = TYPE_META[w.type];
            const isOpen = expanded === w.uid;
            const isRun = w.type !== "strength" && w.type !== "rest";

            return (
              <div key={w.uid}>
                <button
                  onClick={e => {
                    setExpanded(isOpen ? null : w.uid);
                    if (!isOpen) {
                      const row = e.currentTarget.parentElement as HTMLElement | null;
                      const container = scrollRef.current;
                      // Scroll only the card's own list container — never
                      // scrollIntoView, which can also move the outer page
                      // scroll. Computed after the expanding content lays
                      // out, so the row lands at the container's top rather
                      // than wherever it sat before expansion.
                      requestAnimationFrame(() => {
                        if (!row || !container) return;
                        container.scrollTo({ top: row.offsetTop - container.offsetTop, behavior: "smooth" });
                      });
                    }
                  }}
                  className="w-full px-5 py-3 flex items-center gap-3 text-left hover:bg-slate-800/40 transition-colors"
                >
                  {/* Fixed-width weather slot (empty past the forecast range)
                      so the date column stays aligned all the way down. */}
                  <span
                    className="text-xs text-slate-400 shrink-0 w-12"
                    title={weather[w.date] ? `${weather[w.date].description} · feels ${weather[w.date].feelsLikeC}° · ${weather[w.date].precipProb}% rain · ${weather[w.date].windMph}mph at ${weather[w.date].sampledAt}` : undefined}
                  >
                    {weather[w.date] ? `${weather[w.date].emoji} ${weather[w.date].tempC}°` : ""}
                  </span>

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
                    {weather[w.date] && (
                      <p className="text-xs text-sky-300/90">
                        {weather[w.date].emoji} {weather[w.date].description} · {weather[w.date].tempC}°C
                        (feels {weather[w.date].feelsLikeC}°) · {weather[w.date].precipProb}% rain ·{" "}
                        {weather[w.date].windMph}mph · at {weather[w.date].sampledAt}
                      </p>
                    )}
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
                    {aiDjEnabled && ((isRun && w.segments.length > 0) || (w.type === "strength" && w.durationSec > 0)) && (() => {
                      const st = mixState[w.uid];
                      const snap = mixSnapshots[w.date];
                      // A saved/pinned mix already exists for this workout even
                      // before anything is built this session — offer Remix
                      // instead of a fresh AI DJ Mix, seeded to avoid repeating
                      // that persisted mix's tracks.
                      const hasExistingMix = st?.status === "done" || !!(snap && snap.tracks?.length > 0);
                      const snapUris = snap?.tracks.map(t => t.uri).filter((u): u is string => !!u);
                      return (
                        <>
                          <div className="flex flex-wrap items-center gap-2 pt-1">
                            <button
                              onClick={e => { e.stopPropagation(); if (st?.status !== "building") buildMix(w, snapUris); }}
                              disabled={st?.status === "building"}
                              className="text-xs px-2.5 py-1 rounded-lg border bg-purple-500/15 border-purple-500/30 text-purple-300 hover:bg-purple-500/25 disabled:opacity-60 disabled:cursor-wait transition-colors"
                            >
                              {st?.status === "building" ? "🎧 Mixing…" : hasExistingMix ? "🎧 Remix" : "🎧 AI DJ Mix"}
                            </button>
                            {st?.status === "building" && (
                              <MixProgressBar startedAt={st.startedAt ?? Date.now()} progress={st.progress} />
                            )}
                            {st?.status === "done" && (
                              <span className="text-xs text-purple-300/80">Loaded into the track list — review &amp; save from there ↑</span>
                            )}
                            {st?.status === "error" && (
                              <span className="text-xs text-red-400">{st.error}</span>
                            )}
                          </div>
                          {st?.status === "building" && st.progress?.detail && (
                            <p className="text-[11px] text-slate-500 pl-0.5 -mt-1 truncate">{st.progress.detail}</p>
                          )}
                          {st?.warning && (
                            <p className="text-xs text-amber-400/90 mt-1">{st.warning}</p>
                          )}
                          {snap && snap.tracks?.length > 0 && (
                            <div className="mt-1.5 rounded-lg bg-slate-900/50 border border-purple-500/15 px-3 py-2 space-y-1">
                              <p className="text-xs text-purple-300/80 font-medium flex items-center justify-between gap-2">
                                <span>{snap.pinned ? "📌 Pinned mix" : "🎧 Saved mix"} — {snap.tracks.length} tracks</span>
                                <span className="flex items-center gap-2 shrink-0">
                                  {snap.pinned ? (
                                    <button
                                      onClick={e => { e.stopPropagation(); unpinMix(w.date); }}
                                      disabled={unpinningDate === w.date}
                                      className="text-[11px] text-purple-300 hover:text-purple-200 underline disabled:opacity-50"
                                    >
                                      {unpinningDate === w.date ? "Unpinning…" : "Unpin"}
                                    </button>
                                  ) : (
                                    <>
                                      <button
                                        onClick={e => { e.stopPropagation(); repinMix(w.date); }}
                                        disabled={pinningDate === w.date}
                                        className="text-[11px] text-purple-300 hover:text-purple-200 underline disabled:opacity-50"
                                      >
                                        {pinningDate === w.date ? "Pinning…" : "Pin"}
                                      </button>
                                      <button
                                        onClick={e => { e.stopPropagation(); deleteSavedMix(w.date); }}
                                        disabled={deletingDate === w.date}
                                        className="text-[11px] text-red-400/80 hover:text-red-300 underline disabled:opacity-50"
                                      >
                                        {deletingDate === w.date ? "Deleting…" : "Delete"}
                                      </button>
                                    </>
                                  )}
                                  <Link
                                    href={`/mix/${w.date}`}
                                    onClick={e => e.stopPropagation()}
                                    className="text-[11px] text-purple-300 hover:text-purple-200 underline"
                                  >
                                    View chart →
                                  </Link>
                                </span>
                              </p>
                              <div className="max-h-44 overflow-y-auto no-scrollbar space-y-0.5">
                                {snap.tracks.map((t, i) => {
                                  const mm = String(Math.floor(t.startsAtSec / 60)).padStart(2, "0");
                                  const ss = String(Math.floor(t.startsAtSec % 60)).padStart(2, "0");
                                  const spm = t.tempo != null ? String(Math.round(t.tempo)).padStart(3, "0") : "—";
                                  const label = (
                                    <>
                                      <span className="text-slate-600 font-mono">
                                        {mm}:{ss} - {spm}
                                      </span>
                                      {"   "}
                                      {t.name} — <span className="text-slate-500">{t.artist}</span>
                                    </>
                                  );
                                  return t.uri ? (
                                    <p key={i} className="text-[11px] text-slate-400 truncate">
                                      <button
                                        onClick={e => { e.stopPropagation(); openInSpotify(t.uri!); }}
                                        className="hover:text-slate-200 truncate text-left"
                                      >
                                        {label}
                                      </button>
                                    </p>
                                  ) : (
                                    <p key={i} className="text-[11px] text-slate-400 truncate">{label}</p>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </>
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
                    {garminConfigured && isRun && w.distanceMi && courses && (() => {
                      // Courses close to this run's distance — a shade under
                      // through +0.25mi over — newest first (the API already
                      // sorts by creation date descending).
                      const matching = courses.filter(c =>
                        c.distanceMi >= w.distanceMi! - 0.05 && c.distanceMi <= w.distanceMi! + 0.25
                      );
                      if (!matching.length) return null;
                      const offset = courseOffsets[w.uid] ?? 0;
                      const canNewer = offset > 0;
                      const canOlder = offset + 3 < matching.length;
                      const pagerBtn = "px-1.5 py-1 rounded-lg border border-white/10 text-slate-400 hover:text-green-300 hover:border-green-500/30 disabled:opacity-25 disabled:hover:text-slate-400 disabled:hover:border-white/10 transition-colors text-xs shrink-0";
                      const page = (o: number) => setCourseOffsets(s => ({ ...s, [w.uid]: o }));
                      return (
                        <div className="pt-1 space-y-1.5">
                          <p className="text-xs text-slate-500">
                            Courses at this distance ({(w.distanceMi - 0.05).toFixed(2)}–{(w.distanceMi + 0.25).toFixed(2)}mi) · {offset + 1}–{Math.min(offset + 3, matching.length)} of {matching.length}
                          </p>
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={e => { e.stopPropagation(); if (canNewer) page(Math.max(0, offset - 3)); }}
                              disabled={!canNewer}
                              className={pagerBtn}
                              title="Newer courses"
                            >
                              &lt;
                            </button>
                            <div className="flex flex-nowrap gap-1.5 flex-1 min-w-0">
                              {matching.slice(offset, offset + 3).map(c => {
                                const highlight = courseMatchesDate(c.name, w.date);
                                return (
                                  <a
                                    key={c.id}
                                    href={`https://connect.garmin.com/modern/course/${c.id}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={e => e.stopPropagation()}
                                    className={`flex-1 min-w-0 truncate whitespace-nowrap text-center text-xs px-1.5 py-1 rounded-lg border transition-colors ${
                                      highlight
                                        ? "bg-green-500/40 border-green-300/70 text-green-50 font-medium hover:bg-green-500/50"
                                        : "bg-green-500/15 border-green-500/30 text-green-300 hover:bg-green-500/25"
                                    }`}
                                    title={`${c.name} · ${c.distanceMi.toFixed(1)}mi`}
                                  >
                                    {c.name} · {c.distanceMi.toFixed(1)}mi
                                  </a>
                                );
                              })}
                            </div>
                            <button
                              onClick={e => { e.stopPropagation(); if (canOlder) page(offset + 3); }}
                              disabled={!canOlder}
                              className={pagerBtn}
                              title="Older courses"
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
});

// Legacy export so any existing import still compiles
export { RunnaScheduleCard as RunnaCard };
