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
  trackName: string | null;
  artistName: string | null;
  progressMs: number;
  durationMs: number;
  at: number; // Date.now() when progressMs was read
}

function fmt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function SongProgressBar({ trackNames, className = "w-72 max-w-[45%]", barClassName }: {
  /** uri -> "Name — Artist" for the mix's tracks, used as the bar's label. */
  trackNames?: Record<string, string>;
  /** Width classes for the bar's container. */
  className?: string;
  /** When set, the bar (times, slider, play/pause) is its own block with
      these classes — e.g. a fixed width — and the track name sits to its
      left taking only the room it needs, never squeezing the bar. Use with
      className="contents" to make both direct children of the caller's
      flex row. */
  barClassName?: string;
}) {
  const [state, setState] = useState<PlaybackState | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [dragMs, setDragMs] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const poll = useCallback(() => {
    if (typeof document !== "undefined" && document.hidden) return;
    fetch("/api/spotify/playback")
      .then(r => (r.ok ? r.json() : null))
      .then((d: { isPlaying?: boolean; hasDevice?: boolean; trackUri?: string | null; trackName?: string | null; artistName?: string | null; progressMs?: number; durationMs?: number } | null) => {
        if (!d || !d.hasDevice || !d.trackUri) { setState(null); return; }
        setState({
          isPlaying: !!d.isPlaying, trackUri: d.trackUri, trackName: d.trackName ?? null, artistName: d.artistName ?? null,
          progressMs: d.progressMs ?? 0, durationMs: d.durationMs ?? 0, at: Date.now(),
        });
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

  // Always rendered — with nothing detected the bar is idle (times "-:--",
  // no seeking, play/pause disabled).
  const active = !!state && state.durationMs > 0;
  const durationMs = active ? state!.durationMs : 0;
  const live = active ? (state!.isPlaying ? state!.progressMs + (now - state!.at) : state!.progressMs) : 0;
  const posMs = active ? Math.min(dragMs ?? live, durationMs) : 0;
  const pct = active ? (posMs / durationMs) * 100 : 0;

  const msAt = (clientX: number) => {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || !active) return 0;
    return Math.round(Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1) * durationMs);
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

  const name = !active ? "Nothing playing"
    : (state!.trackUri && trackNames?.[state!.trackUri])
      || (state!.trackName ? `${state!.trackName}${state!.artistName ? ` — ${state!.artistName}` : ""}` : "Now playing");

  return (
    <div className={`flex items-center gap-2 shrink-0 ${className}`} title={active ? `${name} — click or drag to change position` : "Nothing playing in Spotify"}>
      <span
        className={`text-[10px] truncate ${barClassName ? "min-w-0 text-right" : "max-w-[45%]"} ${active ? "text-slate-300" : "text-slate-600 italic"}`}
        title={name}
      >
        {name}
      </span>
      <div className={barClassName ? `flex items-center gap-2 ${barClassName}` : "contents"}>
      <span className="text-[10px] text-slate-400 font-mono tabular-nums">{active ? fmt(posMs) : "-:--"}</span>
      <div
        ref={barRef}
        className={`relative flex-1 min-w-16 h-3 group touch-none ${active ? "cursor-pointer" : "cursor-default opacity-50"}`}
        onPointerDown={e => {
          if (!active) return;
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
        {active && (
          <>
            <div className="absolute left-0 top-1/2 -translate-y-1/2 h-1 rounded-full bg-orange-500" style={{ width: `${pct}%` }} />
            <div
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2.5 h-2.5 rounded-full bg-orange-400 opacity-80 group-hover:opacity-100"
              style={{ left: `${pct}%` }}
            />
          </>
        )}
      </div>
      <span className="text-[10px] text-slate-500 font-mono tabular-nums">{active ? fmt(durationMs) : "-:--"}</span>
      <button
        disabled={!active}
        onClick={() => {
          if (!state) return;
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
        title={!active ? "Nothing playing" : state!.isPlaying ? "Pause" : "Play"}
        className="shrink-0 w-6 h-6 rounded-full bg-orange-500/20 border border-orange-500/50 hover:bg-orange-500/35 text-orange-300 text-[10px] leading-none flex items-center justify-center disabled:opacity-40 disabled:hover:bg-orange-500/20"
      >
        {/* Drawn icons — the ▶ character rendered as a blue emoji on Windows. */}
        {active && state!.isPlaying ? (
          <svg viewBox="0 0 10 10" className="w-2.5 h-2.5" fill="currentColor" aria-hidden><rect x="1.5" y="1" width="2.5" height="8" rx="0.5" /><rect x="6" y="1" width="2.5" height="8" rx="0.5" /></svg>
        ) : (
          <svg viewBox="0 0 10 10" className="w-2.5 h-2.5 translate-x-[1px]" fill="currentColor" aria-hidden><path d="M2 1.2v7.6a.5.5 0 0 0 .76.43l6.1-3.8a.5.5 0 0 0 0-.86l-6.1-3.8A.5.5 0 0 0 2 1.2Z" /></svg>
        )}
      </button>
      </div>
    </div>
  );
}
