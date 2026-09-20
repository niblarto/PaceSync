"use client";

import { useEffect, useState } from "react";

// The app's default Spotify playlist (name + id), configurable on the
// Settings page. Falls back to the build-time env id until the config loads;
// fetched once and shared across all components.

export interface RunningPlaylist {
  id: string;
  name: string;
  csvFile: string;
  /** False until /api/settings/playlist has actually resolved — id/name/
      csvFile are the build-time fallback until then, NOT necessarily the
      real active playlist. Callers that take a real, consequential action
      against "the active playlist" (e.g. deleting a track from it on
      Spotify) must check this before using id, or risk silently acting
      against the fallback instead of whatever's actually active — confirmed
      as a real incident: a delete that fired before this resolved removed
      the track from the old "Running" playlist (the fallback env id)
      while the local CSV/blacklist correctly recorded it against the
      NEW active "Running-AI" playlist, so it never actually left Spotify
      and kept reappearing in later Exportify imports. */
  ready: boolean;
}

const FALLBACK_ID = process.env.NEXT_PUBLIC_RUNNING_PLAYLIST_ID ?? "";
const FALLBACK: RunningPlaylist = {
  id: FALLBACK_ID,
  name: "Running",
  csvFile: "Running.csv",
  ready: false,
};

let cached: RunningPlaylist | null = null;
let pending: Promise<RunningPlaylist> | null = null;

export function useRunningPlaylist(): RunningPlaylist {
  const [value, setValue] = useState<RunningPlaylist>(cached ?? FALLBACK);

  useEffect(() => {
    if (cached) { setValue(cached); return; }
    if (!pending) {
      pending = fetch("/api/settings/playlist")
        .then(r => r.json())
        .then((d: { id?: string; name?: string; csvFile?: string }) => {
          cached = { id: d.id || FALLBACK_ID, name: d.name || FALLBACK.name, csvFile: d.csvFile || FALLBACK.csvFile, ready: true };
          return cached;
        })
        .catch(() => (cached = { ...FALLBACK, ready: true })); // fetch itself failed — nothing better to fall back to, but stop blocking callers forever
    }
    let mounted = true;
    pending.then(v => { if (mounted) setValue(v); });
    return () => { mounted = false; };
  }, []);

  return value;
}

// Invalidate after the Settings page changes the default playlist.
export function invalidateRunningPlaylistCache() {
  cached = null;
  pending = null;
}

// For a caller that needs the REAL active playlist before taking a
// consequential action (deleting a track from it on Spotify) rather than a
// component's current (possibly still-fallback) render snapshot — awaits
// the in-flight fetch if one's already running, otherwise starts one.
// Unlike the hook, this never returns the unresolved FALLBACK: it either
// returns a real ready:true playlist or the request genuinely failed.
export async function getRunningPlaylist(): Promise<RunningPlaylist> {
  if (cached) return cached;
  if (!pending) {
    pending = fetch("/api/settings/playlist")
      .then(r => r.json())
      .then((d: { id?: string; name?: string; csvFile?: string }) => {
        cached = { id: d.id || FALLBACK_ID, name: d.name || FALLBACK.name, csvFile: d.csvFile || FALLBACK.csvFile, ready: true };
        return cached;
      })
      .catch(() => (cached = { ...FALLBACK, ready: true }));
  }
  return pending;
}
