"use client";

import { useEffect, useState } from "react";

// Garmin Training Readiness, as one line under the weather on the first item of
// the Runna schedule. Fetched when the row is opened.

interface Readiness {
  date: string;
  at: string;
  score: number;
  level: string;
  advice: string;
  recoveryHours: number | null;
  sleepScore: number | null;
  hrv: number | null;
  acuteLoad: number | null;
  factors: { name: string; feedback: string }[];
}

const LEVEL_COLOUR: Record<string, string> = {
  Prime: "text-emerald-300", High: "text-emerald-300", Moderate: "text-amber-300", Low: "text-orange-300", Poor: "text-rose-300",
};

export function TrainingReadinessLine() {
  const [r, setR] = useState<Readiness | null | undefined>(undefined); // undefined = loading

  useEffect(() => {
    let cancelled = false;
    fetch("/api/garmin/training-readiness")
      .then(res => (res.ok ? res.json() : null))
      .then((d: { readiness?: Readiness | null } | null) => { if (!cancelled) setR(d?.readiness ?? null); })
      .catch(() => { if (!cancelled) setR(null); });
    return () => { cancelled = true; };
  }, []);

  if (r === undefined) return <p className="text-xs text-slate-500">🔋 Training readiness…</p>;
  if (r === null) return null; // not available: say nothing

  const time = r.at.slice(11, 16);
  const detail = [
    r.recoveryHours != null ? `recovery ${r.recoveryHours} h` : "",
    r.sleepScore != null ? `sleep ${r.sleepScore}` : "",
    r.hrv != null ? `HRV ${r.hrv} ms` : "",
  ].filter(Boolean).join(" · ");

  return (
    <p className="text-xs text-slate-300" title={r.factors.map(f => `${f.name}: ${f.feedback}`).join("\n")}>
      🔋 Training readiness{" "}
      <span className={`font-semibold ${LEVEL_COLOUR[r.level] ?? "text-slate-200"}`}>{r.score}</span>
      <span className={LEVEL_COLOUR[r.level] ?? "text-slate-200"}> · {r.level}</span>
      {r.advice && <span className="text-slate-400"> · {r.advice}</span>}
      {detail && <span className="text-slate-500"> · {detail}</span>}
      <span className="text-slate-600"> · at {time}</span>
    </p>
  );
}
