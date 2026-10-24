"use client";

import { useEffect, useState } from "react";
import { BriefBullets } from "./BriefBullets";

// "Last two weeks" at the top of the Runna Summary card: training and recovery
// totals worked out by the app from the Garmin data (no AI, so they're exact).
export function FortnightFacts() {
  const [lines, setLines] = useState<string[] | null>(null);

  useEffect(() => {
    fetch("/api/coach/fortnight")
      .then(r => (r.ok ? r.json() : null))
      .then((d: { lines?: string[] } | null) => setLines(d?.lines ?? null))
      .catch(() => {});
  }, []);

  if (!lines || lines.length === 0) return null;
  return (
    <div className="px-5 py-3 border-b border-white/10 space-y-1.5">
      <p className="text-[10px] uppercase tracking-wide text-slate-500">Last two weeks</p>
      <BriefBullets lines={lines} />
    </div>
  );
}
