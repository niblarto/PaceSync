"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

// Same visual language as SpotifyRateLimitBanner, but polling-based — there's
// no push signal analogous to a 429 for "the library has gaps", so this
// checks /api/settings/heal-now-status (a cheap, local-only, no-network CSV
// scan) on mount and on an interval for as long as the dashboard is open.
// Fixing gaps is a deliberate Settings -> "Heal now" action (the one place
// still allowed to call Spotify) — this banner only surfaces that gaps
// exist, it never triggers a heal itself.
const POLL_MS = 60_000;

interface CsvStatus {
  total: number;
  missingUri: number;
  missingDuration: number;
  missingGenres: number;
  missingFeatures: Record<string, number>;
}

// Only fields that actually exclude a track from AI DJ mixes count here —
// mirrors lib/csv-heal.ts's scanActiveCsv (which deliberately excludes
// Genres for the same reason). missingGenres is real data the CsvStatus
// API returns, but a genre-only gap doesn't affect mix-building, so it must
// never contribute to this banner's count or its "excluded from AI DJ
// mixes" claim — folding it in via Math.max previously let a library with
// plenty of genre-only gaps (and zero actual mix-affecting gaps) show this
// banner anyway.
function missingCount(status: CsvStatus): number {
  const featureMax = Math.max(0, ...Object.values(status.missingFeatures));
  return Math.max(status.missingUri, status.missingDuration, featureMax);
}

export function MissingDataBanner() {
  const [status, setStatus] = useState<CsvStatus | null>(null);
  // Tracks which count was dismissed, so closing the banner for the
  // current gap doesn't also hide a LATER, different-sized gap — the
  // underlying data issue isn't fixed by dismissing, only this notice of it.
  const [dismissedCount, setDismissedCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      fetch("/api/settings/heal-now-status")
        .then(r => r.json())
        .then((d: { status?: CsvStatus }) => { if (!cancelled && d.status) setStatus(d.status); })
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (!status) return null;
  const count = missingCount(status);
  if (count === 0 || count === dismissedCount) return null;

  return (
    <div className="sticky top-14 z-30 bg-amber-500/15 border-b border-amber-500/40 text-amber-300 text-xs px-4 py-2 flex items-center justify-center gap-3">
      <span>⚠ {count} track{count === 1 ? "" : "s"} missing data (BPM/duration) — excluded from AI DJ mixes</span>
      <Link href="/settings" className="underline hover:text-amber-200">Fix in Settings</Link>
      <button
        onClick={() => setDismissedCount(count)}
        className="text-amber-300/70 hover:text-amber-200 leading-none"
        title="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
