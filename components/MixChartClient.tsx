"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { MixPaceChart, type MixChartTrack } from "./MixPaceChart";

interface MixEntry {
  date: string;
  workoutTitle: string;
  tracks: MixChartTrack[];
  pinned?: boolean;
}

export function MixChartClient({ date }: { date: string }) {
  const [entry, setEntry] = useState<MixEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/todays-run/history?date=${date}`)
      .then(r => r.json())
      .then((d: { entry?: MixEntry | null; error?: string }) => {
        if (d.error) { setError(d.error); return; }
        if (!d.entry) { setError("No mix found for this date."); return; }
        setEntry(d.entry);
      })
      .catch(() => setError("Failed to load mix."))
      .finally(() => setLoading(false));
  }, [date]);

  return (
    <div className="min-h-screen flex flex-col bg-slate-950">
      <header className="border-b border-white/5 bg-slate-950/70 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center gap-4">
          <Link href="/dashboard" className="text-sm text-slate-400 hover:text-slate-200 transition-colors">
            ← Dashboard
          </Link>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8 w-full flex-1">
        {loading && <p className="text-slate-500 text-sm">Loading…</p>}
        {error && <p className="text-red-400 text-sm">{error}</p>}
        {entry && (
          <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5">
            <h1 className="font-semibold text-lg mb-1">
              {entry.pinned ? "📌 " : "🎧 "}{entry.workoutTitle || "AI DJ Mix"}
            </h1>
            <p className="text-xs text-slate-500 mb-4">
              {date} · {entry.tracks.length} tracks
            </p>
            <MixPaceChart tracks={entry.tracks} />
          </div>
        )}
      </main>
    </div>
  );
}
