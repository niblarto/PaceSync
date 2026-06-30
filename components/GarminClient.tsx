"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

interface DailySummary {
  day: string;
  steps: number | null;
  rhr: number | null;
  stress_avg: number | null;
  calories_active: number | null;
  distance: number | null;
}

interface SleepRow {
  day: string;
  total_sleep: string | null;
  deep_sleep: string | null;
  light_sleep: string | null;
  rem_sleep: string | null;
  score: number | null;
  qualifier: string | null;
}

interface Activity {
  activity_id: string;
  name: string;
  sport: string;
  sub_sport: string | null;
  start_time: string;
  distance: number | null;
  elapsed_time: string | null;
  avg_hr: number | null;
  max_hr: number | null;
  calories: number | null;
}

interface WeekSummary {
  first_day: string;
  steps: number | null;
  sleep_avg: string | null;
  rhr_avg: number | null;
  stress_avg: number | null;
  activities: number | null;
}

interface GarminData {
  daily: DailySummary[];
  sleep: SleepRow[];
  activities: Activity[];
  weekly: WeekSummary[];
}

// SQLite stores durations as "HH:MM:SS.ffffff" — convert to total seconds
function parseDuration(s: string | number | null): number | null {
  if (s === null || s === undefined) return null;
  if (typeof s === "number") return s;
  const parts = s.split(":");
  if (parts.length < 3) return null;
  const h = parseInt(parts[0]) || 0;
  const m = parseInt(parts[1]) || 0;
  const sec = parseFloat(parts[2]) || 0;
  const total = h * 3600 + m * 60 + sec;
  return total > 0 ? total : null;
}

function fmtDuration(s: string | number | null): string {
  const secs = parseDuration(s);
  if (!secs) return "—";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Distance is stored in miles in this Garmin setup
function fmtDist(miles: number | null): string {
  if (!miles || miles < 0.01) return "—";
  return `${miles.toFixed(1)} mi`;
}

function fmtPace(miles: number | null, elapsed: string | number | null): string {
  const secs = parseDuration(elapsed);
  if (!miles || miles < 0.1 || !secs) return "—";
  const secsPerMile = secs / miles;
  const m = Math.floor(secsPerMile / 60);
  const s = Math.round(secsPerMile % 60);
  return `${m}:${s.toString().padStart(2, "0")} /mi`;
}

// Trim "HH:MM:SS.ffffff" to display "H:MM:SS"
function fmtElapsed(s: string | null): string {
  if (!s) return "—";
  const secs = parseDuration(s);
  if (!secs) return "—";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const sec = Math.round(secs % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

// SQLite dates come as "2026-06-27 00:00:00.000000" — just use the date part
function fmtDate(dateStr: string): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr.slice(0, 10) + "T12:00:00");
  if (isNaN(d.getTime())) return dateStr.slice(0, 10);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function fmtDateTime(ts: string): string {
  if (!ts) return "—";
  // "2026-06-27 09:36:28.000000" → replace space with T for reliable parsing
  const d = new Date(ts.slice(0, 19).replace(" ", "T"));
  if (isNaN(d.getTime())) return ts.slice(0, 16);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function scoreColor(score: number | null): string {
  if (!score) return "text-slate-500";
  if (score >= 80) return "text-green-400";
  if (score >= 60) return "text-yellow-400";
  return "text-red-400";
}

function stressColor(stress: number | null): string {
  if (!stress) return "text-slate-500";
  if (stress < 25) return "text-green-400";
  if (stress < 50) return "text-yellow-400";
  if (stress < 75) return "text-orange-400";
  return "text-red-400";
}

function sportLabel(activity: Activity): string {
  const s = (activity.sub_sport || activity.sport || "").toLowerCase();
  if (s.includes("run")) return "Run";
  if (s.includes("trail")) return "Trail";
  if (s.includes("walk")) return "Walk";
  if (s.includes("cycl") || s.includes("bike") || s.includes("ride")) return "Ride";
  if (s.includes("swim")) return "Swim";
  if (s.includes("hik")) return "Hike";
  return activity.sport || "Activity";
}

function sportColor(activity: Activity): string {
  const label = sportLabel(activity);
  if (label === "Run" || label === "Trail") return "text-green-400";
  if (label === "Walk" || label === "Hike") return "text-emerald-400";
  if (label === "Ride") return "text-blue-400";
  if (label === "Swim") return "text-cyan-400";
  return "text-slate-400";
}

const CARD = "rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5";
const TH = "text-left text-xs font-medium text-slate-500 uppercase tracking-wider pb-2";
const TD = "py-1.5 text-sm text-slate-300";

interface PaceSpmRow {
  bucket: number;
  avg_spm: number | null;
  records: number;
}

const PACE_BUCKETS = Array.from({ length: 43 }, (_, i) => 390 + i * 5);

function fmtBucket(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function spmColor(spm: number | null): string {
  if (!spm) return "text-slate-500";
  if (spm >= 180) return "text-green-400";
  if (spm >= 170) return "text-yellow-400";
  if (spm >= 160) return "text-orange-400";
  return "text-red-400";
}

export function GarminClient() {
  const [data, setData] = useState<GarminData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [paceSpm, setPaceSpm] = useState<PaceSpmRow[] | null>(null);
  const router = useRouter();
  const activityScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/garmin/data")
      .then(r => r.json())
      .then((d: GarminData & { error?: string }) => {
        if (d.error) { setError(d.error); return; }
        setData(d);
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));

    fetch("/api/garmin/pace-spm")
      .then(r => r.json())
      .then((rows: unknown) => {
        if (!Array.isArray(rows)) return;
        setPaceSpm(rows as PaceSpmRow[]);
      })
      .catch(() => undefined);
  }, []);

  // After data loads, scroll back to the last-viewed activity
  useEffect(() => {
    if (!data) return;
    const lastId = sessionStorage.getItem("garmin_last_activity");
    if (!lastId) return;
    sessionStorage.removeItem("garmin_last_activity");

    requestAnimationFrame(() => {
      const el = document.getElementById(`act-${lastId}`);
      const container = activityScrollRef.current;
      if (!el || !container) return;
      // Centre the row in the scroll container
      container.scrollTop = el.offsetTop - container.clientHeight / 2 + el.offsetHeight / 2;
      // Brief highlight flash
      el.style.transition = "background-color 0.15s";
      el.style.backgroundColor = "rgba(255,255,255,0.07)";
      setTimeout(() => { el.style.backgroundColor = ""; }, 1200);
    });
  }, [data]);

  return (
    <div
      className="min-h-screen flex flex-col bg-cover bg-fixed bg-center bg-no-repeat"
      style={{ backgroundImage: "linear-gradient(rgba(2,6,23,0.65), rgba(2,6,23,0.65)), url('/dashboard-hero.png')" }}
    >
      <header className="border-b border-white/5 bg-slate-950/70 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
          <Link href="/dashboard" className="text-sm text-slate-500 hover:text-slate-300 transition-colors">
            ← Dashboard
          </Link>
          <span className="font-bold text-green-400 text-lg tracking-tight">Garmin Stats</span>
          <Link href="/settings" className="text-xs text-slate-500 hover:text-slate-300 transition-colors">
            Settings
          </Link>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 py-8 flex-1 w-full">
        {loading && (
          <div className="text-slate-500 text-sm">Loading Garmin data…</div>
        )}
        {error && (
          <div className="rounded-xl bg-red-950/50 border border-red-800/50 p-4 text-red-400 text-sm">
            {error}
          </div>
        )}

        {data && (
          <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6 items-start">

            {/* Left column — Pace / Cadence reference */}
            <div className="sticky top-20">
              <div className={CARD}>
                <h2 className="font-semibold text-sm text-slate-300 mb-1">Pace / Cadence</h2>
                <p className="text-xs text-slate-500 mb-3">Avg SPM by pace from all activities</p>
                {!paceSpm && (
                  <p className="text-xs text-slate-600">Calculating...</p>
                )}
                {paceSpm && (
                  <div className="max-h-[80vh] overflow-auto no-scrollbar">
                    <table className="w-full">
                      <thead className="sticky top-0 bg-slate-900 z-10">
                        <tr>
                          <th className={TH}>Pace</th>
                          <th className={`${TH} text-right`}>SPM</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/50">
                        {PACE_BUCKETS.map(bucket => {
                          const row = paceSpm.find(r => r.bucket === bucket);
                          const spm = row && row.avg_spm ? Math.round(row.avg_spm) : null;
                          return (
                            <tr key={bucket} className="hover:bg-white/[0.02]">
                              <td className={`${TD} text-slate-400 font-mono text-xs`}>
                                {fmtBucket(bucket)}
                              </td>
                              <td className={`${TD} text-right font-semibold text-xs ${spmColor(spm)}`}>
                                {spm !== null ? spm : "—"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

            {/* Right column — main stats */}
            <div className="space-y-6 min-w-0">

            {/* Activities */}
            <div className={CARD}>
              <h2 className="font-semibold text-sm text-slate-300 mb-4">Activities</h2>
              <div className="max-h-[660px] overflow-auto no-scrollbar" ref={activityScrollRef}>
                <table className="w-full">
                  <thead className="sticky top-0 z-10 bg-slate-900">
                    <tr>
                      <th className={TH}>Date</th>
                      <th className={TH}>Type</th>
                      <th className={TH}>Name</th>
                      <th className={TH}>Distance</th>
                      <th className={TH}>Time</th>
                      <th className={TH}>Pace</th>
                      <th className={TH}>Avg HR</th>
                      <th className={TH}>Cal</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/50">
                    {data.activities.map(a => (
                      <tr
                        key={a.activity_id}
                        id={`act-${a.activity_id}`}
                        className="cursor-pointer hover:bg-white/[0.03] transition-colors"
                        onClick={() => {
                          sessionStorage.setItem("garmin_last_activity", a.activity_id);
                          router.push(`/garmin/activity/${a.activity_id}`);
                        }}
                      >
                        <td className={`${TD} text-slate-500 whitespace-nowrap`}>{fmtDateTime(a.start_time)}</td>
                        <td className={`${TD} font-medium ${sportColor(a)} whitespace-nowrap`}>{sportLabel(a)}</td>
                        <td className={`${TD} text-slate-200`}>{a.name || "—"}</td>
                        <td className={TD}>{fmtDist(a.distance)}</td>
                        <td className={TD}>{fmtElapsed(a.elapsed_time)}</td>
                        <td className={TD}>{fmtPace(a.distance, a.elapsed_time)}</td>
                        <td className={TD}>{a.avg_hr ? `${a.avg_hr}` : "—"}</td>
                        <td className={TD}>{a.calories?.toLocaleString() ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Sleep */}
            <div className={CARD}>
              <h2 className="font-semibold text-sm text-slate-300 mb-4">Sleep — last 14 nights</h2>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr>
                      <th className={TH}>Date</th>
                      <th className={TH}>Total</th>
                      <th className={TH}>Deep</th>
                      <th className={TH}>REM</th>
                      <th className={TH}>Light</th>
                      <th className={TH}>Score</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/50">
                    {data.sleep.map(row => (
                      <tr key={row.day}>
                        <td className={TD}>{fmtDate(row.day)}</td>
                        <td className={TD}>{fmtDuration(row.total_sleep)}</td>
                        <td className={`${TD} text-blue-400`}>{fmtDuration(row.deep_sleep)}</td>
                        <td className={`${TD} text-purple-400`}>{fmtDuration(row.rem_sleep)}</td>
                        <td className={TD}>{fmtDuration(row.light_sleep)}</td>
                        <td className={`${TD} font-medium ${scoreColor(row.score)}`}>
                          {row.score ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Weekly trend */}
            <div className={CARD}>
              <h2 className="font-semibold text-sm text-slate-300 mb-4">Weekly Summary — last 12 weeks</h2>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr>
                      <th className={TH}>Week</th>
                      <th className={TH}>Steps</th>
                      <th className={TH}>Sleep avg</th>
                      <th className={TH}>RHR avg</th>
                      <th className={TH}>Stress avg</th>
                      <th className={TH}>Activities</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/50">
                    {data.weekly.map(w => (
                      <tr key={w.first_day}>
                        <td className={`${TD} text-slate-500`}>{fmtDate(w.first_day)}</td>
                        <td className={TD}>{w.steps?.toLocaleString() ?? "—"}</td>
                        <td className={TD}>{fmtDuration(w.sleep_avg)}</td>
                        <td className={TD}>{w.rhr_avg ? `${Math.round(w.rhr_avg)} bpm` : "—"}</td>
                        <td className={`${TD} ${stressColor(w.stress_avg)}`}>
                          {w.stress_avg ? Math.round(w.stress_avg) : "—"}
                        </td>
                        <td className={TD}>{w.activities ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* 30-day daily detail */}
            <div className={CARD}>
              <h2 className="font-semibold text-sm text-slate-300 mb-4">Daily Detail — last 30 days</h2>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr>
                      <th className={TH}>Date</th>
                      <th className={TH}>Steps</th>
                      <th className={TH}>RHR</th>
                      <th className={TH}>Stress</th>
                      <th className={TH}>Distance</th>
                      <th className={TH}>Active cal</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/50">
                    {data.daily.map(d => (
                      <tr key={d.day}>
                        <td className={`${TD} text-slate-500`}>{fmtDate(d.day)}</td>
                        <td className={TD}>{d.steps?.toLocaleString() ?? "—"}</td>
                        <td className={TD}>{d.rhr ? `${d.rhr} bpm` : "—"}</td>
                        <td className={`${TD} ${stressColor(d.stress_avg)}`}>
                          {d.stress_avg ? Math.round(d.stress_avg) : "—"}
                        </td>
                        <td className={TD}>{fmtDist(d.distance)}</td>
                        <td className={TD}>{d.calories_active?.toLocaleString() ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, valueClass = "text-slate-100" }: { label: string; value: string; valueClass?: string }) {
  return (
    <div>
      <p className="text-xs text-slate-500 mb-0.5">{label}</p>
      <p className={`text-xl font-semibold ${valueClass}`}>{value}</p>
    </div>
  );
}
