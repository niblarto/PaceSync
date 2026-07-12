"use client";

import { useState, useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { useSession } from "next-auth/react";
import { freshSpotifyToken } from "@/lib/spotify-browser";
import Link from "next/link";
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from "recharts";
import { openInSpotify } from "./TrackRow";
import { useRunningPlaylist } from "./useRunningPlaylist";

interface ActivityDetail {
  activity_id: string;
  name: string;
  sport: string;
  sub_sport: string | null;
  start_time: string;
  stop_time: string | null;
  elapsed_time: string | null;
  moving_time: string | null;
  distance: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  calories: number | null;
  avg_speed: number | null;
  max_speed: number | null;
  ascent: number | null;
  descent: number | null;
  training_load: number | null;
  training_effect: number | null;
  anaerobic_training_effect: number | null;
  hrz_1_time: string | null;
  hrz_2_time: string | null;
  hrz_3_time: string | null;
  hrz_4_time: string | null;
  hrz_5_time: string | null;
}

interface LapRow {
  lap: number;
  start_time: string;
  elapsed_time: string | null;
  moving_time: string | null;
  distance: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  avg_cadence: number | null;
  avg_speed: number | null;
  ascent: number | null;
  calories: number | null;
  hrz_1_time: string | null;
  hrz_2_time: string | null;
  hrz_3_time: string | null;
  hrz_4_time: string | null;
  hrz_5_time: string | null;
}

interface StepsData {
  steps: number | null;
  avg_pace: string | null;
  avg_moving_pace: string | null;
  max_pace: string | null;
  avg_steps_per_min: number | null;
  avg_step_length: number | null;
  vo2_max: number | null;
}

interface ChartPoint {
  t: number;
  pace: number | null;
  cadence: number | null;
  hr: number | null;
}

interface ActivityData {
  activity: ActivityDetail;
  laps: LapRow[];
  steps: StepsData | null;
  records: ChartPoint[];
  recordsT0: string | null;
}

interface MixTrack {
  uri: string | null;
  name: string;
  artist: string;
  segment: string;
  startsAtSec: number;
  durationSec: number;
  targetPaceSec: number | null;
  actualPaceSec: number | null;
  verdict: "on" | "fast" | "slow" | "unknown";
  tempo: number | null;
  energy: number | null;
  inLibrary?: boolean; // false once the track has been deleted from the library
}

interface MixPacing {
  activityId: string | number | null;
  tracks: MixTrack[];
  summary: string | null;
}

const MIX_ROW_STYLE: Record<MixTrack["verdict"], string> = {
  on: "bg-green-500/10 border-green-500/30 text-green-300",
  fast: "bg-red-500/10 border-red-500/30 text-red-300",
  slow: "bg-sky-500/10 border-sky-500/30 text-sky-300",
  unknown: "bg-slate-800/40 border-white/5 text-slate-500",
};

function parseDuration(s: string | number | null): number | null {
  if (s === null || s === undefined) return null;
  if (typeof s === "number") return s;
  const parts = s.split(":");
  if (parts.length < 3) return null;
  const h = parseInt(parts[0]) || 0;
  const m = parseInt(parts[1]) || 0;
  const sec = parseFloat(parts[2]) || 0;
  const total = h * 3600 + m * 60 + sec;
  return total > 0 ? total : null;
}

function fmtDuration(s: string | number | null): string {
  const secs = parseDuration(s);
  if (!secs) return "—";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const sec = Math.round(secs % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

// Pace stored as "HH:MM:SS.us" in steps_activities
function fmtPaceStr(s: string | null): string {
  if (!s) return "—";
  const secs = parseDuration(s);
  if (!secs) return "—";
  const m = Math.floor(secs / 60);
  const sec = Math.round(secs % 60);
  return `${m}:${sec.toString().padStart(2, "0")} /mi`;
}

// Format pace in seconds/mile as "M:SS"
function fmtPaceSecs(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function fmtDist(miles: number | null): string {
  if (!miles || miles < 0.01) return "—";
  return `${miles.toFixed(2)} mi`;
}

function fmtDateTime(ts: string): string {
  if (!ts) return "—";
  const d = new Date(ts.slice(0, 19).replace(" ", "T"));
  if (isNaN(d.getTime())) return ts.slice(0, 16);
  return d.toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short",
    year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function fmtDate(ts: string): string {
  if (!ts) return "—";
  const d = new Date(ts.slice(0, 19).replace(" ", "T"));
  if (isNaN(d.getTime())) return ts.slice(0, 10);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

// Format elapsed seconds for the chart X axis. Whole-run views (large spans)
// show "Nm"; zoomed-in views (e.g. a single song, spans under ~4 min) show
// "M:SS" so ticks a few seconds apart don't all collapse to the same label.
function fmtTimeTick(secs: number, spanSec?: number): string {
  if (spanSec !== undefined && spanSec < 240) {
    const m = Math.floor(secs / 60);
    const s = Math.round(secs % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  const m = Math.floor(secs / 60);
  return `${m}m`;
}

const ZONE_COLORS = [
  "bg-emerald-500",
  "bg-green-500",
  "bg-yellow-500",
  "bg-orange-500",
  "bg-red-500",
];
const ZONE_NAMES = ["Zone 1", "Zone 2", "Zone 3", "Zone 4", "Zone 5"];

const CARD = "rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5";
const TH = "text-left text-xs font-medium text-slate-500 uppercase tracking-wider pb-2";
const TD = "py-1.5 text-sm text-slate-300";

// Custom tooltip for HR chart
function HrTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: number;
}) {
  if (!active || !payload?.length || label === undefined) return null;
  const m = Math.floor(label / 60);
  const s = label % 60;
  return (
    <div className="bg-slate-950 border border-white/10 rounded-lg p-2.5 text-xs space-y-1 shadow-xl">
      <p className="text-slate-400 font-medium mb-1">{m}:{s.toString().padStart(2, "0")}</p>
      {payload.map(p => (
        <p key={p.name} style={{ color: p.color }}>{p.value} bpm</p>
      ))}
    </div>
  );
}

// Custom tooltip for pace/cadence chart
function ChartTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: number;
}) {
  if (!active || !payload?.length || label === undefined) return null;
  const m = Math.floor(label / 60);
  const s = label % 60;
  return (
    <div className="bg-slate-950 border border-white/10 rounded-lg p-2.5 text-xs space-y-1 shadow-xl">
      <p className="text-slate-400 font-medium mb-1">{m}:{s.toString().padStart(2, "0")}</p>
      {payload.map(p => (
        <p key={p.name} style={{ color: p.color }}>
          {p.name === "Cadence"
            ? `${p.value} SPM`
            : `${fmtPaceSecs(p.value)} /mi${p.name === "Target" ? " target" : ""}`}
        </p>
      ))}
    </div>
  );
}

export function GarminActivityClient({ id }: { id: string }) {
  const [data, setData] = useState<ActivityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mix, setMix] = useState<MixPacing | null>(null);
  const [votes, setVotes] = useState<{ uri: string; paceSec: number; vote: "up" | "down" }[]>([]);
  const [deletedUris, setDeletedUris] = useState<Set<string>>(new Set());
  const { data: session } = useSession();
  const { id: RUNNING_PLAYLIST_ID } = useRunningPlaylist();

  // Mouse-wheel zoom on the pace/cadence chart: zooms the time axis around
  // the cursor; double-click resets.
  const [xDomain, setXDomain] = useState<[number, number] | null>(null);
  const xDomainRef = useRef(xDomain);
  xDomainRef.current = xDomain;
  const chartWrapRef = useRef<HTMLDivElement>(null);
  const recordsRef = useRef<ChartPoint[]>([]);
  recordsRef.current = data?.records ?? [];

  useEffect(() => {
    const el = chartWrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const records = recordsRef.current;
      if (records.length < 2) return;
      e.preventDefault();
      const dataMin = records[0].t;
      const dataMax = records[records.length - 1].t;
      const cur = xDomainRef.current ?? [dataMin, dataMax];
      const rect = el.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      const center = cur[0] + frac * (cur[1] - cur[0]);
      const factor = e.deltaY > 0 ? 1.25 : 0.8;
      let span = (cur[1] - cur[0]) * factor;
      span = Math.min(dataMax - dataMin, Math.max(60, span));
      let lo = center - frac * span;
      let hi = lo + span;
      if (lo < dataMin) { lo = dataMin; hi = lo + span; }
      if (hi > dataMax) { hi = dataMax; lo = hi - span; }
      setXDomain(span >= dataMax - dataMin ? null : [Math.round(lo), Math.round(hi)]);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [data]);

  // Drag-to-pan: click-hold and move horizontally to shift the visible time
  // window, same span, clamped to the data's actual range. At full zoom the
  // span equals the whole range so panning is a no-op (nowhere to go), which
  // falls out of the clamp naturally.
  //
  // Uses window-level mousemove/mouseup (not pointer capture on the chart
  // element) because Recharts' own Surface/Tooltip mouse handling on the SVG
  // inside chartWrapRef made native PointerEvent capture on the wrapper
  // unreliable — drags would start but stop tracking almost immediately.
  // Listening on window instead sidesteps Recharts entirely and also means
  // the drag keeps tracking even if the pointer leaves the chart area.
  const dragStateRef = useRef<{ startX: number; startDomain: [number, number] } | null>(null);
  const onChartMouseDown = (e: ReactMouseEvent) => {
    const records = recordsRef.current;
    if (records.length < 2) return;
    e.preventDefault();
    dragStateRef.current = {
      startX: e.clientX,
      startDomain: xDomainRef.current ?? [records[0].t, records[records.length - 1].t],
    };
    if (chartWrapRef.current) chartWrapRef.current.style.cursor = "grabbing";
  };
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const drag = dragStateRef.current;
      const el = chartWrapRef.current;
      if (!drag || !el) return;
      const records = recordsRef.current;
      if (records.length < 2) return;
      const dataMin = records[0].t;
      const dataMax = records[records.length - 1].t;
      const rect = el.getBoundingClientRect();
      const [startLo, startHi] = drag.startDomain;
      const span = startHi - startLo;
      const dxFrac = (e.clientX - drag.startX) / rect.width;
      // Dragging right (positive dx) reveals earlier time, like panning a map.
      let lo = startLo - dxFrac * span;
      let hi = lo + span;
      if (lo < dataMin) { lo = dataMin; hi = lo + span; }
      if (hi > dataMax) { hi = dataMax; lo = hi - span; }
      setXDomain([Math.round(lo), Math.round(hi)]);
    };
    const onMouseUp = () => {
      if (!dragStateRef.current) return;
      dragStateRef.current = null;
      if (chartWrapRef.current) chartWrapRef.current.style.cursor = "";
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  useEffect(() => {
    fetch(`/api/garmin/activity/${id}`)
      .then(r => r.json())
      .then((d: ActivityData & { error?: string }) => {
        if (d.error) { setError(d.error); return; }
        setData(d);
        // Load the "Today's Run" mix that was in place for this run's date
        const date = d.activity?.start_time?.slice(0, 10);
        if (date) {
          fetch(`/api/garmin/run-pacing?date=${date}`)
            .then(r => r.json())
            .then((p: MixPacing & { error?: string }) => {
              // Only show when this activity is the one the mix was matched to
              if (!p.error && p.tracks?.length && String(p.activityId) === String(id)) setMix(p);
            })
            .catch(() => {});
        }
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));

    fetch("/api/track-feedback")
      .then(r => r.json())
      .then((d: { votes?: { uri: string; paceSec: number; vote: "up" | "down" }[] }) => setVotes(d.votes ?? []))
      .catch(() => {});
  }, [id]);

  function voteFor(t: MixTrack): "up" | "down" | null {
    if (!t.uri || t.targetPaceSec == null) return null;
    const v = votes.find(v => v.uri === t.uri && Math.abs(v.paceSec - (t.targetPaceSec as number)) <= 10);
    return v?.vote ?? null;
  }

  function castVote(t: MixTrack, vote: "up" | "down") {
    if (!t.uri || t.targetPaceSec == null) return;
    const next = voteFor(t) === vote ? null : vote; // clicking again clears
    fetch("/api/track-feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uri: t.uri, paceSec: t.targetPaceSec, vote: next }),
    })
      .then(r => r.json())
      .then((d: { votes?: { uri: string; paceSec: number; vote: "up" | "down" }[] }) => { if (d.votes) setVotes(d.votes); })
      .catch(() => {});
  }

  // Remove the song from the Running playlist and library CSV — same as the
  // dashboard's delete (the row stays, struck through, as a record of what
  // played on this run).
  function deleteTrack(t: MixTrack) {
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
        }).then(async r => {
          if (!r.ok) console.error(`[delete] Spotify ${r.status}: ${await r.text().catch(() => "")}`);
        });
      }).catch(err => console.error("[delete] Spotify fetch error:", err));
    }
    fetch("/api/tracks/delete", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spotifyUri: uri }),
    }).catch(() => {});
  }

  const a = data?.activity;

  // Expected pace over time from the mix (song playing at each moment) —
  // drawn on the pace chart in blue.
  const targetAt = (t: number): number | null => {
    if (!mix) return null;
    const track = mix.tracks.find(x => t >= x.startsAtSec && t < x.startsAtSec + x.durationSec);
    return track?.targetPaceSec ?? null;
  };
  const chartRecords = mix
    ? (data?.records ?? []).map(r => ({ ...r, target: targetAt(r.t) }))
    : data?.records ?? [];

  // HR zone times and total for the bar chart
  const zoneTimes = a ? [
    parseDuration(a.hrz_1_time) ?? 0,
    parseDuration(a.hrz_2_time) ?? 0,
    parseDuration(a.hrz_3_time) ?? 0,
    parseDuration(a.hrz_4_time) ?? 0,
    parseDuration(a.hrz_5_time) ?? 0,
  ] : [];
  const zoneTotal = zoneTimes.reduce((s, v) => s + v, 0);
  const hasZones = zoneTotal > 0;

  const hasChart = (data?.records?.length ?? 0) > 0;

  // Compute pace domain: padded around the actual range so fast/slow sections
  // are visually distinct. Reversed so faster pace is at the top.
  const paceDomain = (() => {
    if (!hasChart) return [300, 720] as [number, number];
    const paces = (data?.records ?? []).map(r => r.pace).filter((p): p is number => p !== null);
    (mix?.tracks ?? []).forEach(t => { if (t.targetPaceSec) paces.push(t.targetPaceSec); });
    if (!paces.length) return [300, 720] as [number, number];
    const min = Math.min(...paces);
    const max = Math.max(...paces);
    const pad = (max - min) * 0.1;
    return [Math.max(180, Math.floor(min - pad)), Math.ceil(max + pad)] as [number, number];
  })();

  const hasHr = hasChart && (data?.records ?? []).some(r => r.hr !== null);

  // Track timeline strip beneath the pace/cadence chart: each song's slice of
  // the chart's current time domain, positioned/sized to line up with the X
  // axis above it. Clipped to the visible domain so the strip stays in sync
  // while zoomed.
  const timelineDomain: [number, number] = xDomain ?? (hasChart
    ? [data!.records[0].t, data!.records[data!.records.length - 1].t]
    : [0, 0]);

  // Explicit X-axis ticks within the zoomed domain — Recharts' own
  // interval="preserveStartEnd" computes against the full dataset's min/max,
  // not the current domain, so it kept forcing stray ticks at 0:00/end-of-run
  // even when zoomed into one song. Picking "nice" round intervals ourselves
  // (5/10/30/60s, else whole minutes) avoids that and keeps ticks legible.
  const xTicks = (() => {
    const [lo, hi] = timelineDomain;
    const span = hi - lo;
    if (!hasChart || span <= 0) return undefined;
    const step = span < 60 ? 5 : span < 150 ? 10 : span < 300 ? 30 : span < 600 ? 60 : Math.ceil(span / 8 / 60) * 60;
    const ticks: number[] = [];
    for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push(t);
    return ticks;
  })();
  const timelineTracks = mix
    ? mix.tracks
        .map(t => ({
          ...t,
          clipStart: Math.max(t.startsAtSec, timelineDomain[0]),
          clipEnd: Math.min(t.startsAtSec + t.durationSec, timelineDomain[1]),
        }))
        .filter(t => t.clipEnd > t.clipStart)
    : [];

  // Workout segment strip above the song strip: each mix track already
  // carries which segment it was built for (e.g. "3.11mi time trial at
  // 7:30/mi") — merge consecutive tracks sharing a segment into one block
  // spanning from the first track's start to the last track's end, so the
  // row reads as "conversational · interval 1 · rest · interval 2 · …"
  // instead of repeating the same label per song. Computed from the full
  // (unclipped) mix.tracks, not timelineTracks, so a block's true start/end
  // survives being clicked to zoom in — otherwise a block visible only
  // partially at the current zoom would zoom to its clipped (wrong) extent.
  const segmentSpans = mix
    ? (() => {
        const spans: { segment: string; startsAtSec: number; endsAtSec: number }[] = [];
        for (const t of mix.tracks) {
          const end = t.startsAtSec + t.durationSec;
          const last = spans[spans.length - 1];
          if (last && last.segment === t.segment) {
            last.endsAtSec = end;
          } else {
            spans.push({ segment: t.segment, startsAtSec: t.startsAtSec, endsAtSec: end });
          }
        }
        return spans;
      })()
    : [];
  // Short rests (<2min) don't get a track-fill pass of their own — music
  // keeps playing through them — but the backend still records the fold as
  // "<segment label> + <rest label>" (see ai_dj/workout.py parse_workout).
  // Split that back into two adjacent chips here, sized by the rest's own
  // stated duration, so the strip still reads "interval · rest" even though
  // both halves share the same underlying tracks.
  const REST_SUFFIX_RE = / \+ ((\d+)\s*(s|sec|secs|min|mins?)\b[^,]*)$/i;
  const splitSegmentSpans = segmentSpans.flatMap(span => {
    const m = span.segment.match(REST_SUFFIX_RE);
    if (!m) return [span];
    const value = parseInt(m[2], 10);
    const restSec = m[3].startsWith("min") ? value * 60 : value;
    const totalSec = span.endsAtSec - span.startsAtSec;
    if (restSec <= 0 || restSec >= totalSec) return [span];
    const splitAt = span.endsAtSec - restSec;
    return [
      { segment: span.segment.slice(0, m.index), startsAtSec: span.startsAtSec, endsAtSec: splitAt },
      { segment: m[1], startsAtSec: splitAt, endsAtSec: span.endsAtSec },
    ];
  });
  const segmentBlocks = splitSegmentSpans
    .map(b => ({
      ...b,
      clipStart: Math.max(b.startsAtSec, timelineDomain[0]),
      clipEnd: Math.min(b.endsAtSec, timelineDomain[1]),
    }))
    .filter(b => b.clipEnd > b.clipStart);

  return (
    <div
      className="min-h-screen flex flex-col bg-cover bg-fixed bg-center bg-no-repeat"
      style={{ backgroundImage: "linear-gradient(rgba(2,6,23,0.65), rgba(2,6,23,0.65)), url('/dashboard-hero.png')" }}
    >
      <header className="border-b border-white/5 bg-slate-950/70 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
          <Link href="/garmin" className="text-sm text-slate-500 hover:text-slate-300 transition-colors">
            ← Garmin Stats
          </Link>
          <span className="font-bold text-green-400 text-lg tracking-tight">Activity</span>
          <div />
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-4 py-8 flex-1 w-full space-y-5">
        {loading && <div className="text-slate-500 text-sm">Loading…</div>}
        {error && (
          <div className="rounded-xl bg-red-950/50 border border-red-800/50 p-4 text-red-400 text-sm">{error}</div>
        )}

        {a && (
          <>
            {/* Title */}
            <div>
              <p className="text-xs text-slate-500 mb-1">{fmtDateTime(a.start_time)}</p>
              <h1 className="text-xl font-semibold">
                <a
                  href={`https://connect.garmin.com/app/activity/${id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-slate-100 hover:text-green-400 transition-colors"
                >
                  {a.name || "Activity"}
                </a>
              </h1>
              <p className="text-sm text-slate-500 capitalize mt-0.5">{a.sub_sport || a.sport}</p>
            </div>

            {/* Key stats */}
            <div className={CARD}>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-5">
                <Stat label="Distance" value={fmtDist(a.distance)} />
                <Stat label="Time" value={fmtDuration(a.elapsed_time)} />
                <Stat label="Avg pace" value={fmtPaceStr(data?.steps?.avg_pace ?? null)} />
                <Stat label="Best pace" value={fmtPaceStr(data?.steps?.max_pace ?? null)} />
                <Stat label="Avg HR" value={a.avg_hr ? `${a.avg_hr} bpm` : "—"} />
                <Stat label="Max HR" value={a.max_hr ? `${a.max_hr} bpm` : "—"} />
                <Stat label="Calories" value={a.calories?.toLocaleString() ?? "—"} />
                <Stat label="Steps" value={data?.steps?.steps?.toLocaleString() ?? "—"} />
                <Stat label="Ascent" value={a.ascent ? `${Math.round(a.ascent)} ft` : "—"} />
                <Stat label="Descent" value={a.descent ? `${Math.round(a.descent)} ft` : "—"} />
                <Stat label="VO₂ max" value={data?.steps?.vo2_max ? `${data.steps.vo2_max}` : "—"} />
                <Stat
                  label="Training effect"
                  value={a.training_effect ? `${a.training_effect.toFixed(1)}` : "—"}
                />
              </div>
            </div>

            {/* Pace & Cadence chart */}
            {hasChart && (
              <div className={CARD}>
                <h2 className="font-semibold text-sm text-slate-300 mb-1">Pace & Cadence</h2>
                <p className="text-xs text-slate-500 mb-4">
                  10-second averages — faster pace at top, cadence on right axis ·
                  scroll to zoom, drag to pan{xDomain ? " · " : ", "}
                  {xDomain
                    ? <button onClick={() => setXDomain(null)} className="text-sky-400 hover:text-sky-300 underline">reset zoom</button>
                    : "double-click to reset"}
                </p>
                <div
                  ref={chartWrapRef}
                  onDoubleClick={() => setXDomain(null)}
                  onMouseDown={onChartMouseDown}
                  className="cursor-grab"
                  style={{ touchAction: "none", userSelect: "none" }}
                >
                <ResponsiveContainer width="100%" height={260}>
                  <ComposedChart
                    data={chartRecords}
                    margin={{ top: 4, right: 52, left: 4, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />

                    {/* X: elapsed time */}
                    <XAxis
                      dataKey="t"
                      type="number"
                      scale="linear"
                      domain={xDomain ?? ["dataMin", "dataMax"]}
                      allowDataOverflow
                      tickFormatter={t => fmtTimeTick(t, timelineDomain[1] - timelineDomain[0])}
                      tick={{ fill: "#64748b", fontSize: 10 }}
                      axisLine={{ stroke: "rgba(255,255,255,0.06)" }}
                      tickLine={false}
                      {...(xTicks ? { ticks: xTicks } : { interval: "preserveStartEnd", tickCount: 8 })}
                    />

                    {/* Left Y: pace (reversed → faster at top) */}
                    <YAxis
                      yAxisId="pace"
                      orientation="left"
                      reversed
                      domain={paceDomain}
                      tickFormatter={fmtPaceSecs}
                      tick={{ fill: "#34d399", fontSize: 10 }}
                      axisLine={false}
                      tickLine={false}
                      width={36}
                      tickCount={5}
                      allowDecimals={false}
                    />

                    {/* Right Y: cadence SPM */}
                    <YAxis
                      yAxisId="cadence"
                      orientation="right"
                      domain={[130, "auto"]}
                      tick={{ fill: "#fb923c", fontSize: 10 }}
                      axisLine={false}
                      tickLine={false}
                      width={36}
                      tickCount={5}
                      allowDecimals={false}
                    />

                    <Tooltip content={<ChartTooltip />} />

                    <Line
                      yAxisId="pace"
                      type="monotone"
                      dataKey="pace"
                      name="Pace"
                      stroke="#34d399"
                      strokeWidth={1.5}
                      dot={false}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                    <Line
                      yAxisId="cadence"
                      type="monotone"
                      dataKey="cadence"
                      name="Cadence"
                      stroke="#fb923c"
                      strokeWidth={1.5}
                      dot={false}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                    {mix && (
                      <Line
                        yAxisId="pace"
                        type="stepAfter"
                        dataKey="target"
                        name="Target"
                        stroke="#3b82f6"
                        strokeWidth={1.5}
                        strokeDasharray="5 3"
                        dot={false}
                        connectNulls={false}
                        isAnimationActive={false}
                      />
                    )}
                  </ComposedChart>
                </ResponsiveContainer>
                </div>

                {segmentBlocks.length > 0 && (
                  // Same padding/positioning math as the song strip below,
                  // so the two rows line up under the chart's X axis.
                  <div className="mt-2" style={{ paddingLeft: 40, paddingRight: 88 }}>
                    <div className="relative h-6 rounded overflow-hidden border border-white/5 bg-slate-800/60">
                      {segmentBlocks.map((b, i) => {
                        const span = timelineDomain[1] - timelineDomain[0];
                        const leftPct = span > 0 ? ((b.clipStart - timelineDomain[0]) / span) * 100 : 0;
                        const widthPct = span > 0 ? ((b.clipEnd - b.clipStart) / span) * 100 : 0;
                        const isZoomedToThis = xDomain
                          && Math.abs(xDomain[0] - b.startsAtSec) < 1
                          && Math.abs(xDomain[1] - b.endsAtSec) < 1;
                        return (
                          <button
                            key={i}
                            onClick={() => setXDomain([b.startsAtSec, b.endsAtSec])}
                            title={b.segment}
                            className={`absolute top-0 h-full flex items-center justify-center overflow-hidden border-r border-slate-950/60 transition-colors ${
                              isZoomedToThis
                                ? "bg-indigo-500/60 hover:bg-indigo-500/70"
                                : i % 2 === 0
                                  ? "bg-indigo-500/20 hover:bg-indigo-500/35"
                                  : "bg-indigo-500/10 hover:bg-indigo-500/25"
                            }`}
                            style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                          >
                            {widthPct > 4 && (
                              <span className="text-[10px] text-indigo-200 px-1 truncate whitespace-nowrap font-medium">
                                {b.segment}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {timelineTracks.length > 0 && (
                  // Padding must match the chart's actual plot-area insets, not
                  // just its margin — each Y axis (width 36) sits inside the
                  // margin too, so the true left/right offsets are
                  // margin + axis width (4+36=40, 52+36=88), not just the margin.
                  <div className="mt-2" style={{ paddingLeft: 40, paddingRight: 88 }}>
                    <div className="relative h-6 rounded overflow-hidden border border-white/5 bg-slate-800/40">
                      {timelineTracks.map((t, i) => {
                        const span = timelineDomain[1] - timelineDomain[0];
                        const leftPct = span > 0 ? ((t.clipStart - timelineDomain[0]) / span) * 100 : 0;
                        const widthPct = span > 0 ? ((t.clipEnd - t.clipStart) / span) * 100 : 0;
                        const isZoomedToThis = xDomain
                          && Math.abs(xDomain[0] - t.startsAtSec) < 1
                          && Math.abs(xDomain[1] - (t.startsAtSec + t.durationSec)) < 1;
                        return (
                          <button
                            key={i}
                            onClick={() => setXDomain([t.startsAtSec, t.startsAtSec + t.durationSec])}
                            title={`${t.name} — ${t.artist}`}
                            className={`absolute top-0 h-full flex items-center justify-center overflow-hidden border-r border-slate-950/60 transition-colors ${
                              isZoomedToThis
                                ? "bg-purple-500/50 hover:bg-purple-500/60"
                                : i % 2 === 0
                                  ? "bg-slate-700/50 hover:bg-purple-500/40"
                                  : "bg-slate-700/30 hover:bg-purple-500/40"
                            }`}
                            style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                          >
                            {widthPct > 4 && (
                              <span className="text-[10px] text-slate-200 px-1 truncate whitespace-nowrap">
                                {t.name}
                                {isZoomedToThis && (t.tempo != null || t.energy != null) && (
                                  <span className="text-slate-400">
                                    {" · "}
                                    {t.tempo != null ? `${Math.round(t.tempo)} BPM` : ""}
                                    {t.tempo != null && t.energy != null ? " · " : ""}
                                    {t.energy != null ? `energy ${t.energy.toFixed(2)}` : ""}
                                  </span>
                                )}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-[10px] text-slate-600 mt-1">
                      🎧 Song playing at each point — click a song to zoom the chart to it
                    </p>
                  </div>
                )}

                <div className="flex gap-6 mt-3 text-xs text-slate-500">
                  <span className="flex items-center gap-1.5">
                    <span className="w-4 h-0.5 bg-emerald-400 inline-block rounded" />
                    Pace /mi
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-4 h-0.5 bg-orange-400 inline-block rounded" />
                    Cadence (SPM)
                  </span>
                  {mix && (
                    <span className="flex items-center gap-1.5">
                      <span className="w-4 h-0.5 bg-blue-500 inline-block rounded" />
                      Target pace /mi
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* "Today's Run" mix vs pace */}
            {mix && mix.tracks.length > 0 && (
              <div className={CARD}>
                <h2 className="font-semibold text-sm text-slate-300 mb-1">🎧 Mix vs Pace</h2>
                <p className="text-xs text-slate-500 mb-3">
                  Expected pace while each song played (±10 s/mi tolerance) —
                  <span className="text-green-400"> on pace</span> ·
                  <span className="text-red-400"> too fast</span> ·
                  <span className="text-sky-400"> too slow</span>.
                  👎 drops a song from mixes at this pace, 👍 plays it more often.
                </p>
                <div className="space-y-1 max-h-80 overflow-y-auto pr-1">
                  {mix.tracks.map((t, i) => {
                    const v = voteFor(t);
                    const isDeleted = t.uri !== null && (deletedUris.has(t.uri) || t.inLibrary === false);
                    return (
                      <div
                        key={i}
                        className={`flex items-center gap-2 text-xs rounded border px-2 py-1.5 ${MIX_ROW_STYLE[t.verdict]} ${isDeleted ? "opacity-40 line-through" : ""}`}
                        title={t.segment}
                      >
                        <span className="text-slate-600 shrink-0 tabular-nums w-10">{fmtTimeTick(t.startsAtSec)}</span>
                        {t.uri ? (
                          <button
                            onClick={() => openInSpotify(t.uri!)}
                            className="flex-1 min-w-0 truncate text-left hover:underline"
                            title={`${t.name} — open in Spotify`}
                          >
                            {t.name} <span className="opacity-60">— {t.artist}</span>
                          </button>
                        ) : (
                          <span className="flex-1 min-w-0 truncate">{t.name} <span className="opacity-60">— {t.artist}</span></span>
                        )}
                        <span className="shrink-0 tabular-nums" title="actual / expected pace per mile">
                          {t.actualPaceSec ? fmtPaceSecs(t.actualPaceSec) : "—"}
                          {t.targetPaceSec ? ` / ${fmtPaceSecs(t.targetPaceSec)}` : ""}
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
                {mix.summary && <p className="text-xs text-slate-400 mt-2">{mix.summary}</p>}
              </div>
            )}

            {/* HR over time chart */}
            {hasHr && (
              <div className={CARD}>
                <h2 className="font-semibold text-sm text-slate-300 mb-1">Heart Rate</h2>
                <p className="text-xs text-slate-500 mb-4">10-second averages</p>
                <ResponsiveContainer width="100%" height={200}>
                  <ComposedChart
                    data={data!.records}
                    margin={{ top: 4, right: 16, left: 4, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                    <XAxis
                      dataKey="t"
                      type="number"
                      scale="linear"
                      domain={["dataMin", "dataMax"]}
                      tickFormatter={fmtTimeTick}
                      tick={{ fill: "#64748b", fontSize: 10 }}
                      axisLine={{ stroke: "rgba(255,255,255,0.06)" }}
                      tickLine={false}
                      interval="preserveStartEnd"
                      tickCount={8}
                    />
                    <YAxis
                      domain={["auto", "auto"]}
                      tick={{ fill: "#f87171", fontSize: 10 }}
                      axisLine={false}
                      tickLine={false}
                      width={32}
                    />
                    <Tooltip content={<HrTooltip />} />
                    <Area
                      type="monotone"
                      dataKey="hr"
                      name="HR"
                      stroke="#f87171"
                      strokeWidth={1.5}
                      fill="#f87171"
                      fillOpacity={0.12}
                      dot={false}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
                <div className="flex gap-6 mt-3 text-xs text-slate-500">
                  <span className="flex items-center gap-1.5">
                    <span className="w-4 h-0.5 bg-red-400 inline-block rounded" />
                    Heart rate (bpm)
                  </span>
                </div>
              </div>
            )}

            {/* HR zone bar */}
            {hasZones && (
              <div className={CARD}>
                <h2 className="font-semibold text-sm text-slate-300 mb-4">Heart Rate Zones</h2>
                <div className="flex h-6 rounded-lg overflow-hidden gap-0.5">
                  {zoneTimes.map((t, i) => {
                    const pct = zoneTotal > 0 ? (t / zoneTotal) * 100 : 0;
                    if (pct < 0.5) return null;
                    return (
                      <div
                        key={i}
                        className={`${ZONE_COLORS[i]} transition-all`}
                        style={{ width: `${pct}%` }}
                        title={`${ZONE_NAMES[i]}: ${fmtDuration(t)}`}
                      />
                    );
                  })}
                </div>
                <div className="flex gap-4 mt-3 flex-wrap">
                  {zoneTimes.map((t, i) => (
                    <div key={i} className="flex items-center gap-1.5 text-xs text-slate-400">
                      <span className={`w-2.5 h-2.5 rounded-sm ${ZONE_COLORS[i]}`} />
                      <span>{ZONE_NAMES[i]}</span>
                      <span className="text-slate-500">{fmtDuration(t) || "—"}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-slate-500 mb-0.5">{label}</p>
      <p className="text-lg font-semibold text-slate-100">{value}</p>
    </div>
  );
}
