"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Spotify playback position for whatever's playing now, with click/drag to
// seek — shown beside the Pace Chart's song strip. Polls /api/spotify/
// playback (server-side token) every POLL_MS while the page is visible and
// interpolates locally in between, so the bar moves smoothly without
// hammering Spotify.

const POLL_MS = 5000;
const EVENT = "pacesync:playback-changed";

// Tells every SongProgressBar on the page to re-read the player now (after
// a track is started from somewhere).
export function notifyPlaybackChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT));
}

// After a preview click: make sure Spotify is actually playing (it can stay
// paused if it was paused before), resuming it if not, and refresh the bars.
export function ensurePlaying(): void {
  setTimeout(() => {
    fetch("/api/spotify/playback")
      .then(r => (r.ok ? r.json() : null))
      .then((d: { isPlaying?: boolean; hasDevice?: boolean } | null) => {
        if (d?.hasDevice && !d.isPlaying) {
          return fetch("/api/spotify/playback", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "resume" }),
          });
        }
      })
      .catch(() => {})
      .finally(() => setTimeout(notifyPlaybackChanged, 400));
  }, 900);
}

interface PlaybackState {
  isPlaying: boolean;
  trackUri: string | null;
  progressMs: number;
  durationMs: number;
  at: number; // Date.now() when progressMs was read
}

function fmt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function SongProgressBar({ trackNames, className = "w-72 max-w-[45%]" }: {
  /** uri -> "Name — Artist" for the mix's tracks, used as the bar's label. */
  trackNames?: Record<string, string>;
  /** Width classes for the bar's container. */
  className?: string;
}) {
  const [state, setState] = useState<PlaybackState | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [dragMs, setDragMs] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const poll = useCallback(() => {
    if (typeof document !== "undefined" && document.hidden) return;
    fetch("/api/spotify/playback")
      .then(r => (r.ok ? r.json() : null))
      .then((d: { isPlaying?: boolean; hasDevice?: boolean; trackUri?: string | null; progressMs?: number; durationMs?: number } | null) => {
        if (!d || !d.hasDevice || !d.trackUri) { setState(null); return; }
        setState({ isPlaying: !!d.isPlaying, trackUri: d.trackUri, progressMs: d.progressMs ?? 0, durationMs: d.durationMs ?? 0, at: Date.now() });
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    poll();
    const id = setInterval(poll, POLL_MS);
    const onVis = () => { if (!document.hidden) poll(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener(EVENT, poll);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener(EVENT, poll);
    };
  }, [poll]);

  // Local tick for smooth movement between polls.
  useEffect(() => {
    if (!state?.isPlaying) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [state?.isPlaying]);

  if (!state || state.durationMs <= 0) return null;

  const live = state.isPlaying ? state.progressMs + (now - state.at) : state.progressMs;
  const posMs = Math.min(dragMs ?? live, state.durationMs);
  const pct = (posMs / state.durationMs) * 100;

  const msAt = (clientX: number) => {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    return Math.round(Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1) * state.durationMs);
  };

  const seek = (ms: number) => {
    setState(s => (s ? { ...s, progressMs: ms, at: Date.now() } : s));
    fetch("/api/spotify/playback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "seek", positionMs: ms }),
    })
      .then(() => setTimeout(poll, 600))
      .catch(() => {});
  };

  const label = (state.trackUri && trackNames?.[state.trackUri]) || "Now playing";

  return (
    <div className={`flex items-center gap-2 shrink-0 ${className}`} title={`${label} — click or drag to change position`}>
      <span className="text-[10px] text-slate-400 font-mono tabular-nums">{fmt(posMs)}</span>
      <div
        ref={barRef}
        className="relative flex-1 h-3 cursor-pointer group touch-none"
        onPointerDown={e => {
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragMs(msAt(e.clientX));
        }}
        onPointerMove={e => { if (dragMs !== null) setDragMs(msAt(e.clientX)); }}
        onPointerUp={e => {
          if (dragMs === null) return;
          const ms = msAt(e.clientX);
          setDragMs(null);
          seek(ms);
        }}
        onPointerCancel={() => setDragMs(null)}
      >
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 rounded-full bg-slate-700" />
        <div className="absolute left-0 top-1/2 -translate-y-1/2 h-1 rounded-full bg-orange-500" style={{ width: `${pct}%` }} />
        <div
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2.5 h-2.5 rounded-full bg-orange-400 opacity-80 group-hover:opacity-100"
          style={{ left: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] text-slate-500 font-mono tabular-nums">{fmt(state.durationMs)}</span>
      <button
        onClick={() => {
          const resume = !state.isPlaying;
          // Optimistic: freeze/restart the local position straight away.
          setState(s => (s ? { ...s, isPlaying: resume, progressMs: live, at: Date.now() } : s));
          fetch("/api/spotify/playback", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: resume ? "resume" : "pause" }),
          })
            .then(() => setTimeout(poll, 600))
            .catch(() => {});
        }}
        title={state.isPlaying ? "Pause" : "Play"}
        className="shrink-0 w-6 h-6 rounded-full bg-orange-500/20 border border-orange-500/50 hover:bg-orange-500/35 text-orange-300 text-[10px] leading-none flex items-center justify-center"
      >
        {state.isPlaying ? "❚❚" : "▶"}
      </button>
    </div>
  );
}
