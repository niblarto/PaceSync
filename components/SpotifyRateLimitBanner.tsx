"use client";

import { useEffect, useState } from "react";
import { subscribeSpotifyRateLimit, seedSpotifyRateLimitFromServer } from "@/lib/spotify-browser";

// "1h 2m 3s" / "2m 3s" / "3s", trimming leading zero units so a 4-second wait
// just shows "4s" instead of "0h 0m 4s".
function fmtDuration(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (h > 0 || m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

// Small pinned banner that appears the instant any spotifyFetch() call (see
// lib/spotify-browser.ts) hits a 429, showing a live, accurate countdown to
// when the rate limit actually clears — for however long that is, not just
// the short waits that auto-retry. It disappears only once its own countdown
// reaches zero (never early, e.g. when a retry happens to fire), so it's
// always trustworthy: if it says 47s, the limit really is in effect for 47s.
// One banner covers every Spotify call site on the page — delete, add, save,
// search, cleanup — since they all report into the same shared state instead
// of each needing their own inline status UI.
export function SpotifyRateLimitBanner() {
  const [retryAtMs, setRetryAtMs] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  // Tracks which retryAtMs value the user dismissed, so closing the banner
  // for the current rate limit doesn't also hide the NEXT one — the limit
  // itself isn't cleared by dismissing, only this notification of it.
  const [dismissedAtMs, setDismissedAtMs] = useState<number | null>(null);

  useEffect(() => subscribeSpotifyRateLimit(setRetryAtMs), []);

  // Check the persisted server-side sentinel once on mount, so a page
  // load/refresh that lands right in the middle of an already-active ban
  // shows the banner immediately instead of staying silent until the next
  // live Spotify call in this session happens to fail again.
  useEffect(() => {
    fetch("/api/spotify/rate-limit-status")
      .then(r => r.json())
      .then((d: { until?: string | null }) => {
        if (d.until) seedSpotifyRateLimitFromServer(new Date(d.until).getTime());
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (retryAtMs == null) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [retryAtMs]);

  if (retryAtMs == null || retryAtMs === dismissedAtMs) return null;
  const secondsLeft = Math.max(0, Math.ceil((retryAtMs - now) / 1000));
  if (secondsLeft <= 0) return null;

  return (
    <div className="sticky top-14 z-30 bg-amber-500/15 border-b border-amber-500/40 text-amber-300 text-xs px-4 py-2 flex items-center justify-center gap-3">
      <span>⚠ Rate limited by Spotify — clears in {fmtDuration(secondsLeft)}…</span>
      <button
        onClick={() => setDismissedAtMs(retryAtMs)}
        className="text-amber-300/70 hover:text-amber-200 leading-none"
        title="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
