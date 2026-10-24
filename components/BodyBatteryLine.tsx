"use client";

import { useEffect, useState } from "react";

// Garmin Body Battery as one line under Training Readiness on the first item of
// the Runna schedule. Fetched when the row is opened.

interface BodyBattery {
  current: number | null;
  atWake: number | null;
  high: number | null;
  low: number | null;
  charged: number | null;
  drained: number | null;
}

// Garmin's bands: 0-25 low, 26-50 medium, 51-75 high, 76-100 very high.
function colour(v: number): string {
  return v >= 76 ? "text-emerald-300" : v >= 51 ? "text-lime-300" : v >= 26 ? "text-amber-300" : "text-rose-300";
}

export function BodyBatteryLine() {
  const [b, setB] = useState<BodyBattery | null | undefined>(undefined); // undefined = loading

  useEffect(() => {
    let cancelled = false;
    fetch("/api/garmin/body-battery")
      .then(res => (res.ok ? res.json() : null))
      .then((d: { bodyBattery?: BodyBattery | null } | null) => { if (!cancelled) setB(d?.bodyBattery ?? null); })
      .catch(() => { if (!cancelled) setB(null); });
    return () => { cancelled = true; };
  }, []);

  if (b === undefined) return <p className="text-xs text-slate-500">⚡ Body battery…</p>;
  if (b === null || b.current == null) return null; // not available: say nothing

  const detail = [
    b.atWake != null ? `woke at ${b.atWake}` : "",
    b.high != null && b.low != null ? `today ${b.low}–${b.high}` : "",
    b.charged != null && b.drained != null ? `+${b.charged} charged, −${b.drained} drained` : "",
  ].filter(Boolean).join(" · ");

  return (
    <p className="text-xs text-slate-300">
      ⚡ Body battery <span className={`font-semibold ${colour(b.current)}`}>{b.current}</span>
      {detail && <span className="text-slate-500"> · {detail}</span>}
    </p>
  );
}
