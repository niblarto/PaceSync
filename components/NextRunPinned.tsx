"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRunnaData } from "@/components/RunnaCard";

interface MixSnapshot {
  workoutTitle: string;
  tracks: { uri: string | null; name: string; artist: string; startsAtSec: number; tempo: number | null }[];
  pinned?: boolean;
}

interface PinnedRouteInfo { activityId: string; name: string; distanceMi: number; runDate: string }

// Mobile-only "what's coming up" strip, shown above the schedule so the
// pinned tracklist's first track and any pinned route are visible without
// tapping the next run's card open (the schedule card only fetches this data
// once expanded — see RunnaScheduleCard). Renders nothing if the next run has
// neither a pinned mix nor a pinned route.
export function NextRunPinned() {
  const { workouts, pastRuns } = useRunnaData();
  const nextRun = workouts.find(w => !pastRuns.some(r => r.date === w.date));

  const [mix, setMix] = useState<MixSnapshot | null | undefined>(undefined);
  const [route, setRoute] = useState<PinnedRouteInfo | null | undefined>(undefined);

  useEffect(() => {
    if (!nextRun) return;
    setMix(undefined);
    setRoute(undefined);
    fetch(`/api/todays-run/history?date=${nextRun.date}&title=${encodeURIComponent(nextRun.title)}`)
      .then(r => r.json())
      .then((d: { entry?: MixSnapshot | null }) => setMix(d.entry ?? null))
      .catch(() => setMix(null));
    fetch(`/api/garmin/pin-route?date=${nextRun.date}&title=${encodeURIComponent(nextRun.title)}`)
      .then(r => r.json())
      .then((d: { route?: PinnedRouteInfo | null }) => setRoute(d.route ?? null))
      .catch(() => setRoute(null));
  }, [nextRun?.date, nextRun?.title]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!nextRun) return null;
  const pinnedTrack = mix?.pinned ? mix.tracks[0] : null;
  if (!pinnedTrack && !route) return null;

  return (
    <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 px-4 py-3 space-y-1.5">
      {pinnedTrack && (
        <p className="text-sm text-slate-200 truncate">
          📌 First up: <span className="text-slate-300">{pinnedTrack.name}</span>
          <span className="text-slate-500"> — {pinnedTrack.artist}</span>
        </p>
      )}
      {route && (
        <Link
          href={`/mobile/route/${route.activityId}`}
          className="text-sm text-green-400 hover:text-green-300 hover:underline inline-block"
        >
          📍 Pinned route: {route.runDate} · {route.distanceMi.toFixed(1)}mi
        </Link>
      )}
    </div>
  );
}
