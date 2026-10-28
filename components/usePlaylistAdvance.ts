"use client";

import { useEffect, useRef } from "react";
import { notifyPlaybackChanged } from "@/components/SongProgressBar";

interface Playback {
  hasDevice?: boolean;
  isPlaying?: boolean;
  trackUri?: string | null;
  progressMs?: number;
  durationMs?: number;
}

async function readPlayback(): Promise<Playback | null> {
  try {
    const r = await fetch("/api/spotify/playback", { cache: "no-store" });
    return r.ok ? await r.json() as Playback : null;
  } catch {
    return null;
  }
}

/**
 * Treats a list of tracks as a playlist: when the track that's playing (and is in the list) finishes,
 * the next one down the list starts. Spotify plays a clicked track on its own, so without this it just stops.
 * Does nothing if the playing track isn't in the list, or the user paused / skipped / seeked meanwhile.
 */
export function usePlaylistAdvance(getUris: () => string[]) {
  const getUrisRef = useRef(getUris);
  getUrisRef.current = getUris;

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let armedFor: string | null = null; // the track whose end we're already waiting for

    const schedule = (ms: number) => { if (!stopped) timer = setTimeout(tick, ms); };

    async function playNext(finished: string) {
      const uris = getUrisRef.current();
      const idx = uris.indexOf(finished);
      const next = idx === -1 ? undefined : uris[idx + 1];
      if (!next) return;
      try {
        await fetch("/api/spotify/play", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uri: next }),
        });
      } catch { /* the next poll sorts out where playback is */ }
      setTimeout(notifyPlaybackChanged, 600);
    }

    async function onEnd(track: string) {
      const d = await readPlayback();
      armedFor = null;
      if (stopped || !d?.hasDevice) return;
      const nearEnd = (d.durationMs ?? 0) - (d.progressMs ?? 0) < 3000;
      const list = getUrisRef.current();
      // Playing as a Spotify playlist (the _WIP one): Spotify has already moved on to the next track itself.
      if (d.trackUri && d.trackUri === list[list.indexOf(track) + 1]) return;
      if (d.trackUri === track) {
        // Still on it: finished and stopped, or the user paused/seeked. Only a stopped track that's at (or reset to) its end counts.
        if (!d.isPlaying && (nearEnd || (d.progressMs ?? 0) < 2000)) await playNext(track);
      } else if (d.isPlaying && (d.progressMs ?? 0) < 6000) {
        // Spotify rolled on to something else by itself (autoplay) right at the end — carry on down our list instead.
        await playNext(track);
      }
    }

    async function tick() {
      if (stopped) return;
      const d = await readPlayback();
      let delay = 5000;
      if (d?.hasDevice && d.isPlaying && d.trackUri && (d.durationMs ?? 0) > 0 && getUrisRef.current().includes(d.trackUri)) {
        const remaining = (d.durationMs ?? 0) - (d.progressMs ?? 0);
        if (remaining <= 7000 && armedFor !== d.trackUri) {
          const track = d.trackUri;
          armedFor = track;
          setTimeout(() => { if (!stopped) void onEnd(track); }, Math.max(remaining, 0) + 500);
          delay = remaining + 2500; // look again after the end has been handled
        } else if (armedFor === d.trackUri) {
          delay = Math.max(remaining, 0) + 2500;
        } else {
          delay = Math.min(5000, Math.max(remaining - 6500, 1500)); // wake up just before the end
        }
      }
      schedule(delay);
    }

    schedule(1500);
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, []);
}
