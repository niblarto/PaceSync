"use client";

import { useEffect, useState } from "react";

// Upcoming schedule / Pace Pro tracklists that still contain a deleted
// track (lib/broken-tracklists.ts via /api/tracklists/broken). Shared by the
// warning banner and the deleted-track highlight in a loaded mix. One fetch
// is shared by every component on the page; any library delete or mix
// repair calls notifyTracklistsChanged() to refetch.

export interface BrokenTracklist {
  kind: "schedule" | "pacepro";
  key: string;
  title: string;
  date: string | null;
  missing: { uri: string; name: string; artist: string }[];
  link: string;
}

export interface BrokenTracklistsState {
  broken: BrokenTracklist[];
  missingUris: Set<string>;
}

const EVENT = "pacesync:tracklists-changed";
const EMPTY: BrokenTracklistsState = { broken: [], missingUris: new Set() };

let cache: BrokenTracklistsState | null = null;
let inFlight: Promise<BrokenTracklistsState> | null = null;

function load(): Promise<BrokenTracklistsState> {
  if (!inFlight) {
    inFlight = fetch("/api/tracklists/broken")
      .then(r => (r.ok ? r.json() : null))
      .then((d: { broken?: BrokenTracklist[]; missingUris?: string[] } | null) => {
        cache = d ? { broken: d.broken ?? [], missingUris: new Set(d.missingUris ?? []) } : (cache ?? EMPTY);
        return cache;
      })
      .catch(() => cache ?? EMPTY)
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}

// Call after a library delete or a mix save/swap. The delete request is
// fire-and-forget in most callers, so refetch again shortly after too.
export function notifyTracklistsChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(EVENT));
  setTimeout(() => window.dispatchEvent(new Event(EVENT)), 1500);
}

export function useBrokenTracklists(): BrokenTracklistsState {
  const [state, setState] = useState<BrokenTracklistsState>(cache ?? EMPTY);
  useEffect(() => {
    let alive = true;
    const refresh = () => { load().then(s => { if (alive) setState(s); }); };
    refresh();
    window.addEventListener(EVENT, refresh);
    window.addEventListener("focus", refresh);
    return () => {
      alive = false;
      window.removeEventListener(EVENT, refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  return state;
}
