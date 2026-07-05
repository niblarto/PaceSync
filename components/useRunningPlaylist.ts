"use client";

import { useEffect, useState } from "react";

// The app's default Spotify playlist (name + id), configurable on the
// Settings page. Falls back to the build-time env id until the config loads;
// fetched once and shared across all components.

export interface RunningPlaylist {
  id: string;
  name: string;
  csvFile: string;
}

const FALLBACK: RunningPlaylist = {
  id: process.env.NEXT_PUBLIC_RUNNING_PLAYLIST_ID ?? "",
  name: "Running",
  csvFile: "Running.csv",
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
          cached = { id: d.id || FALLBACK.id, name: d.name || FALLBACK.name, csvFile: d.csvFile || FALLBACK.csvFile };
          return cached;
        })
        .catch(() => (cached = FALLBACK));
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
