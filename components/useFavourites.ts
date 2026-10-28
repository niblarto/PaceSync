"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Starred tracks (Pace Pro / Race mixes use these first at their BPM). Optimistic toggle, undone on failure. */
export function useFavourites() {
  const [favourites, setFavourites] = useState<Set<string>>(new Set());
  const latest = useRef(favourites);
  latest.current = favourites;

  useEffect(() => {
    fetch("/api/tracks/favourites")
      .then(r => r.json())
      .then((d: { uris?: string[] }) => setFavourites(new Set(d.uris ?? [])))
      .catch(() => {});
  }, []);

  const toggle = useCallback((uri: string) => {
    const make = !latest.current.has(uri);
    const apply = (on: boolean) => setFavourites(prev => {
      const next = new Set(prev);
      if (on) next.add(uri); else next.delete(uri);
      return next;
    });
    apply(make); // optimistic
    fetch("/api/tracks/favourites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uri, favourite: make }),
    })
      .then(r => { if (!r.ok) throw new Error(); })
      .catch(() => apply(!make)); // undo on failure
  }, []);

  return { favourites, toggle };
}
