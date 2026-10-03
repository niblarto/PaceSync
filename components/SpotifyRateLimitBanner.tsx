"use client";

import { useEffect, useState } from "react";
import { subscribeSpotifyRateLimit, seedSpotifyRateLimitFromServer, fmtRateLimitDuration, type RateLimitState } from "@/lib/spotify-browser";

// Small pinned banner that appears the instant any spotifyFetch() call (see
// lib/spotify-browser.ts) hits a 429, showing a live, accurate countdown to
// when the rate limit actually clears — for however long that is, not just
// the short waits that auto-retry. It disappears only once its own countdown
// reaches zero (never early, e.g. when a retry happens to fire), so it's
// always trustworthy: if it says 47s, the limit really is in effect for 47s.
//
// Shows which ACCOUNT is affected — the main OAuth account (playlist add/
// remove/play/delete, your own Spotify login) and the search apps (library
// lookups, the heal sweep, BBC matching, bulk import) are independent
// Spotify apps with independent rate budgets, so a 429 on one never implies
// the other is also blocked. Both can be shown at once if both happen to be
// limited simultaneously.
export function SpotifyRateLimitBanner() {
  const [state, setState] = useState<RateLimitState>({ main: null, search: null });
  const [now, setNow] = useState(Date.now());
  // Tracks which retryAt value (per lane) the user dismissed, so closing the
  // banner for the current rate limit doesn't also hide the NEXT one — the
  // limit itself isn't cleared by dismissing, only this notification of it.
  const [dismissed, setDismissed] = useState<{ main: number | null; search: number | null }>({ main: null, search: null });

  useEffect(() => subscribeSpotifyRateLimit(setState), []);

  // Check the persisted server-side sentinels once on mount, so a page
  // load/refresh that lands right in the middle of an already-active ban
  // shows the banner immediately instead of staying silent until the next
  // live Spotify call in this session happens to fail again. The search
  // lane in particular has NO client-side fetch path of its own, so this
  // poll is its only way to ever reach the banner.
  useEffect(() => {
    fetch("/api/spotify/rate-limit-status")
      .then(r => r.json())
      .then((d: { main?: string | null; search?: string | null }) => {
        if (d.main) seedSpotifyRateLimitFromServer(new Date(d.main).getTime(), "main");
        if (d.search) seedSpotifyRateLimitFromServer(new Date(d.search).getTime(), "search");
      })
      .catch(() => {});
  }, []);

  const anyActive = state.main != null || state.search != null;
  useEffect(() => {
    if (!anyActive) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [anyActive]);

  const rows: { lane: "main" | "search"; label: string; retryAtMs: number }[] = [];
  if (state.main != null && state.main !== dismissed.main) {
    const secondsLeft = Math.max(0, Math.ceil((state.main - now) / 1000));
    if (secondsLeft > 0) rows.push({ lane: "main", label: "Main account", retryAtMs: state.main });
  }
  if (state.search != null && state.search !== dismissed.search) {
    const secondsLeft = Math.max(0, Math.ceil((state.search - now) / 1000));
    if (secondsLeft > 0) rows.push({ lane: "search", label: "Lookup account", retryAtMs: state.search });
  }
  if (rows.length === 0) return null;

  return (
    <div className="sticky top-14 z-30 bg-amber-500/15 border-b border-amber-500/40 text-amber-300 text-xs">
      {rows.map(r => {
        const secondsLeft = Math.max(0, Math.ceil((r.retryAtMs - now) / 1000));
        return (
          <div key={r.lane} className="px-4 py-2 flex items-center justify-center gap-3">
            <span>⚠ Rate limited by Spotify ({r.label}) — clears in {fmtRateLimitDuration(secondsLeft)}…</span>
            <button
              onClick={() => setDismissed(prev => ({ ...prev, [r.lane]: r.retryAtMs }))}
              className="text-amber-300/70 hover:text-amber-200 leading-none"
              title="Dismiss"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
