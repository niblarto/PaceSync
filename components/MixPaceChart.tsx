"use client";

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";

// Shared shape for a mix track with pacing/segment info — matches
// lib/todays-run-history.ts's HistoryTrack (the AI DJ mix's per-track
// pacing snapshot), used both for a freshly-built mix (converted client-side
// from its timeline) and a saved/pinned mix loaded from the API.
export interface MixChartTrack {
  uri: string | null;
  name: string;
  artist: string;
  segment: string;
  startsAtSec: number;
  durationSec: number;
  targetPaceSec: number | null;
  tempo: number | null;
}

// Mirrors lib/todays-run-history.ts's timelineToHistoryTracks — duplicated
// here (rather than imported) because that file pulls in fs/path for its
// other exports, which can't bundle into a client component.
interface TimelineSegment {
  segment: string;
  targetPaceSec?: number | null;
  tracks: { uri: string | null; name: string; artist: string; startsAt: string; durationSec?: number; tempo: number | null }[];
}
function mmssToSec(v: string): number {
  const p = String(v).split(":").map(Number);
  return p.some(isNaN) ? 0 : p.reduce((acc, x) => acc * 60 + x, 0);
}
export function timelineToChartTracks(timeline: TimelineSegment[]): MixChartTrack[] {
  const tracks: MixChartTrack[] = [];
  (timeline ?? []).forEach(seg => {
    (seg.tracks ?? []).forEach(t => {
      tracks.push({
        uri: t.uri ?? null,
        name: t.name,
        artist: t.artist,
        segment: seg.segment,
        startsAtSec: mmssToSec(t.startsAt),
        durationSec: t.durationSec ?? 0,
        targetPaceSec: seg.targetPaceSec ?? null,
        tempo: t.tempo ?? null,
      });
    });
  });
  return tracks;
}

// Below ~95 BPM a runner locks onto double-time, not the raw beat — mirrors
// ai_dj/workout.py's _effective_run_tempo, which the mix builder already
// uses to pick/BPM-match tracks. The chart plots this effective tempo (not
// the raw one) so a correctly-picked slow track doesn't look like a mismatch
// against the target-pace line; the raw tempo is still shown alongside it
// wherever the doubled value is displayed, so it's clear what happened.
const DOUBLETIME_THRESHOLD = 95;
function effectiveTempo(tempo: number): number {
  return tempo < DOUBLETIME_THRESHOLD ? tempo * 2 : tempo;
}

// Rounded to whole BPM everywhere the track list itself shows rounded BPM
// (e.g. "167 BPM") — plotting raw decimals made tracks that display as the
// same BPM still draw a visible micro-step between them on the chart.
function chartBpm(tempo: number): number {
  return Math.round(effectiveTempo(tempo));
}

function fmtPaceSecs(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function fmtTimeTick(secs: number, spanSec?: number): string {
  if (spanSec !== undefined && spanSec < 240) {
    const m = Math.floor(secs / 60);
    const s = Math.round(secs % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  const m = Math.floor(secs / 60);
  return `${m}m`;
}

interface ChartPoint {
  t: number;
  target: number | null;
  bpm: number | null;
}

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
          {p.name === "BPM" ? `${Math.round(p.value)} BPM` : `${fmtPaceSecs(p.value)} /mi target`}
        </p>
      ))}
    </div>
  );
}

const REST_SUFFIX_RE = / \+ ((\d+)\s*(s|sec|secs|min|mins?)\b[^,]*)$/i;

// Renders a target-pace-vs-song-BPM chart for an AI DJ mix, with a segment
// timeline strip and a song strip below it — the same visual language as the
// post-run Garmin activity chart (components/GarminActivityClient.tsx), but
// built from a mix's own planned data (no actual pace, since it hasn't been
// run yet) so it can be shown the moment a mix is built or reloaded from a
// saved/pinned snapshot. `tracks` should be the full ordered mix track list.
export function MixPaceChart({ tracks }: { tracks: MixChartTrack[] }) {
  const [xDomain, setXDomain] = useState<[number, number] | null>(null);
  const xDomainRef = useRef(xDomain);
  xDomainRef.current = xDomain;
  const chartWrapRef = useRef<HTMLDivElement>(null);
  const tracksRef = useRef<MixChartTrack[]>(tracks);
  tracksRef.current = tracks;

  // Reset zoom whenever the mix itself changes (new build/remix/reload).
  useEffect(() => {
    setXDomain(null);
  }, [tracks]);

  const totalSec = tracks.length
    ? Math.max(...tracks.map(t => t.startsAtSec + t.durationSec))
    : 0;

  // One chart point per track boundary (start) plus a closing point at the
  // end of the last track, so target-pace renders as a stepped line and BPM
  // as a line through each track's own tempo.
  const records: ChartPoint[] = tracks.length
    ? [
        ...tracks.map(t => ({ t: t.startsAtSec, target: t.targetPaceSec, bpm: t.tempo != null ? chartBpm(t.tempo) : null })),
        {
          t: totalSec,
          target: tracks[tracks.length - 1].targetPaceSec,
          bpm: tracks[tracks.length - 1].tempo != null ? chartBpm(tracks[tracks.length - 1].tempo!) : null,
        },
      ]
    : [];

  useEffect(() => {
    const el = chartWrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const recs = tracksRef.current;
      if (recs.length < 2 || totalSec <= 0) return;
      e.preventDefault();
      const dataMin = 0;
      const dataMax = totalSec;
      const cur = xDomainRef.current ?? [dataMin, dataMax];
      const rect = el.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      const center = cur[0] + frac * (cur[1] - cur[0]);
      const factor = e.deltaY > 0 ? 1.25 : 0.8;
      let span = (cur[1] - cur[0]) * factor;
      span = Math.min(dataMax - dataMin, Math.max(30, span));
      let lo = center - frac * span;
      let hi = lo + span;
      if (lo < dataMin) { lo = dataMin; hi = lo + span; }
      if (hi > dataMax) { hi = dataMax; lo = hi - span; }
      setXDomain(span >= dataMax - dataMin ? null : [Math.round(lo), Math.round(hi)]);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [totalSec]);

  const dragStateRef = useRef<{ startX: number; startDomain: [number, number] } | null>(null);
  const onChartMouseDown = (e: ReactMouseEvent) => {
    if (totalSec <= 0) return;
    e.preventDefault();
    dragStateRef.current = {
      startX: e.clientX,
      startDomain: xDomainRef.current ?? [0, totalSec],
    };
    if (chartWrapRef.current) chartWrapRef.current.style.cursor = "grabbing";
  };
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const drag = dragStateRef.current;
      const el = chartWrapRef.current;
      if (!drag || !el || totalSec <= 0) return;
      const dataMin = 0;
      const dataMax = totalSec;
      const rect = el.getBoundingClientRect();
      const [startLo, startHi] = drag.startDomain;
      const span = startHi - startLo;
      const dxFrac = (e.clientX - drag.startX) / rect.width;
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
  }, [totalSec]);

  if (!tracks.length) return null;

  const timelineDomain: [number, number] = xDomain ?? [0, totalSec];
  const span = timelineDomain[1] - timelineDomain[0];
  const xTicks = (() => {
    if (span <= 0) return undefined;
    const step = span < 60 ? 5 : span < 150 ? 10 : span < 300 ? 30 : span < 600 ? 60 : Math.ceil(span / 8 / 60) * 60;
    const ticks: number[] = [];
    for (let t = Math.ceil(timelineDomain[0] / step) * step; t <= timelineDomain[1]; t += step) ticks.push(t);
    return ticks;
  })();

  const paceValues = tracks.map(t => t.targetPaceSec).filter((v): v is number => v != null);
  const paceDomain: [number, number] = paceValues.length
    ? [Math.min(...paceValues) - 15, Math.max(...paceValues) + 15]
    : [300, 600];

  const timelineTracks = tracks
    .map(t => ({
      ...t,
      clipStart: Math.max(t.startsAtSec, timelineDomain[0]),
      clipEnd: Math.min(t.startsAtSec + t.durationSec, timelineDomain[1]),
    }))
    .filter(t => t.clipEnd > t.clipStart);

  const segmentSpans = (() => {
    const spans: { segment: string; startsAtSec: number; endsAtSec: number }[] = [];
    for (const t of tracks) {
      const end = t.startsAtSec + t.durationSec;
      const last = spans[spans.length - 1];
      if (last && last.segment === t.segment) {
        last.endsAtSec = end;
      } else {
        spans.push({ segment: t.segment, startsAtSec: t.startsAtSec, endsAtSec: end });
      }
    }
    return spans;
  })();
  const splitSegmentSpans = segmentSpans.flatMap(s => {
    const m = s.segment.match(REST_SUFFIX_RE);
    if (!m) return [s];
    const value = parseInt(m[2], 10);
    const restSec = m[3].startsWith("min") ? value * 60 : value;
    const total = s.endsAtSec - s.startsAtSec;
    if (restSec <= 0 || restSec >= total) return [s];
    const splitAt = s.endsAtSec - restSec;
    return [
      { segment: s.segment.slice(0, m.index), startsAtSec: s.startsAtSec, endsAtSec: splitAt },
      { segment: m[1], startsAtSec: splitAt, endsAtSec: s.endsAtSec },
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
    <div>
      <p className="text-xs text-slate-500 mb-4">
        Target pace vs. song BPM per segment · scroll to zoom, drag to pan{xDomain ? " · " : ", "}
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
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={records} margin={{ top: 4, right: 52, left: 4, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
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
            <YAxis
              yAxisId="pace"
              orientation="left"
              reversed
              domain={paceDomain}
              tickFormatter={fmtPaceSecs}
              tick={{ fill: "#3b82f6", fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              width={36}
              tickCount={5}
              allowDecimals={false}
            />
            <YAxis
              yAxisId="bpm"
              orientation="right"
              domain={["auto", "auto"]}
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
            <Line
              yAxisId="bpm"
              type="stepAfter"
              dataKey="bpm"
              name="BPM"
              stroke="#fb923c"
              strokeWidth={1.5}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {segmentBlocks.length > 0 && (
        <div className="mt-2" style={{ paddingLeft: 40, paddingRight: 88 }}>
          <div className="relative h-6 rounded overflow-hidden border border-white/5 bg-slate-800/60">
            {segmentBlocks.map((b, i) => {
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
        <div className="mt-2" style={{ paddingLeft: 40, paddingRight: 88 }}>
          <div className="relative h-6 rounded overflow-hidden border border-white/5 bg-slate-800/40">
            {timelineTracks.map((t, i) => {
              const leftPct = span > 0 ? ((t.clipStart - timelineDomain[0]) / span) * 100 : 0;
              const widthPct = span > 0 ? ((t.clipEnd - t.clipStart) / span) * 100 : 0;
              const isZoomedToThis = xDomain
                && Math.abs(xDomain[0] - t.startsAtSec) < 1
                && Math.abs(xDomain[1] - (t.startsAtSec + t.durationSec)) < 1;
              return (
                <button
                  key={i}
                  onClick={() => setXDomain([t.startsAtSec, t.startsAtSec + t.durationSec])}
                  title={t.tempo != null && t.tempo < DOUBLETIME_THRESHOLD
                    ? `${t.name} — ${t.artist} (${Math.round(t.tempo)} BPM, felt as ${Math.round(effectiveTempo(t.tempo))} double-time)`
                    : `${t.name} — ${t.artist}`}
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
                      {isZoomedToThis && t.tempo != null && (
                        <span className="text-slate-400">
                          {" · "}{Math.round(effectiveTempo(t.tempo))} BPM
                          {t.tempo < DOUBLETIME_THRESHOLD && <span className="text-amber-400">{" ×2"}</span>}
                        </span>
                      )}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <p className="text-[10px] text-slate-600 mt-1">
            🎧 Song playing at each point — click a song or segment to zoom
          </p>
        </div>
      )}
    </div>
  );
}
