"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

// Shows a dismissible notice on the dashboard when the library has any
// near-duplicate track groups (same song under two-plus different Spotify
// track IDs — e.g. an original single vs. a "- Remastered 2011" reissue),
// same grouping SettingsClient's "Possible duplicates" panel already
// computes. Same visual pattern as SpotifyRateLimitBanner — sticky under
// the header, dismissible without clearing the underlying condition, so
// re-navigating to the dashboard shows it again next time if duplicates
// still exist. Unlike the rate-limit banner this doesn't self-clear on a
// timer; it re-checks once per mount instead, since duplicate count has no
// natural "expiry."
export function DuplicateTracksBanner() {
  const [count, setCount] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    fetch("/api/settings/duplicate-count")
      .then(r => r.json())
      .then((d: { count?: number }) => setCount(d.count ?? 0))
      .catch(() => setCount(0));
  }, []);

  if (!count || dismissed) return null;

  return (
    <div className="sticky top-14 z-30 bg-amber-500/15 border-b border-amber-500/40 text-amber-300 text-xs px-4 py-2 flex items-center justify-center gap-3">
      <span>
        🎭 {count} possible duplicate{count === 1 ? "" : "s"} in your library —{" "}
        <Link href="/settings?tab=tracklist" className="underline hover:text-amber-200">
          review in Settings
        </Link>
      </span>
      <button
        onClick={() => setDismissed(true)}
        className="text-amber-300/70 hover:text-amber-200 leading-none"
        title="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
