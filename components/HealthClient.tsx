"use client";

import { TopNav } from "@/components/TopNav";
import { AiSummaryPanel } from "@/components/AiSummaryPanel";
import { SleepTimelineModal } from "@/components/SleepTimelineModal";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Area, Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

// The Health page: sleep and HRV from Garmin for the last month (14 / 30 / 90 days), as headline numbers and one chart
// (sleep stages as stacked bars, nightly HRV as a line over Garmin's "balanced" band), with an AI summary at the bottom.
// Mirrors lib/health-dashboard.ts.
interface HealthDay {
  date: string;
  sleepSec: number | null; deepSec: number | null; lightSec: number | null; remSec: number | null; awakeSec: number | null;
  sleepScore: number | null; sleepQualifier: string | null;
  hrv: number | null; hrvWeekly: number | null; hrvStatus: string | null; hrvLow: number | null; hrvHigh: number | null;
  restingHr: number | null;
  ignored: boolean; // ignored by the user (right-click → Ignore this night): left out of the averages, headline figures and AI summary
}
interface Averages { sleepSec: number | null; sleepScore: number | null; hrv: number | null; restingHr: number | null; nights: number }
// Garmin's Sleep Coach (lib/sleep-coach.ts)
interface SleepNeed { forDate: string; needMin: number; baselineMin: number; change: string | null; reasons: string[] }
interface SleepCoach { date: string; tonight: SleepNeed | null; lastNight: SleepNeed | null; verdict: string | null; verdictTone: "good" | "fair" | "poor" | null; insight: string | null; actualMin: number | null }
interface Dashboard {
  today: string; days: HealthDay[]; latestSleep: HealthDay | null; latestHrv: HealthDay | null; sleepCoach: SleepCoach | null;
  avg7: Averages; avgAll: Averages; hrvAvailable: boolean; sources: { garminDb: string | null };
}

const RANGES = [14, 30, 90];
const AUTO_REFRESH_MS = 15 * 60_000;

const C = { deep: "#4f46e5", rem: "#a855f7", light: "#38bdf8", unstaged: "#64748b", hrv: "#fbbf24", hrvAvg: "#f97316", band: "#34d399", axis: "#64748b", grid: "rgba(255,255,255,0.05)" };

const shortDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const longDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const hm = (sec: number | null | undefined) => (sec == null ? "—" : `${Math.floor(sec / 3600)}h ${String(Math.round((sec % 3600) / 60)).padStart(2, "0")}m`);
const hours = (sec: number | null) => (sec == null ? null : Math.round(sec / 36) / 100);
const statusColor = (s: string | null) => (!s ? "text-slate-400" : /balanced/i.test(s) && !/un/i.test(s) ? "text-emerald-300" : /unbalanced/i.test(s) ? "text-amber-300" : "text-rose-300");

// Is an HRV figure in your range? Garmin works out a "balanced" band from your own history; inside it is normal for you
// (good), above it is higher than usual (generally well recovered), below it is lower than usual (tired, stressed or
// unwell). A figure a little under the band is amber, well under it is red.
function hrvVerdict(value: number, low: number | null, high: number | null): { label: string; icon: string; color: string } | null {
  if (low == null || high == null) return null;
  if (value >= low && value <= high) return { label: "Within your range: good", icon: "✓", color: "text-emerald-300" };
  if (value > high) return { label: "Above your range: good", icon: "▲", color: "text-sky-300" };
  return value >= low * 0.9
    ? { label: "Just below your range", icon: "▼", color: "text-amber-300" }
    : { label: "Below your range: low", icon: "▼", color: "text-rose-300" };
}

// A thin gauge: the green band is your range, the dot is where this reading sits against it.
function HrvGauge({ value, low, high }: { value: number; low: number; high: number }) {
  const pad = Math.max(8, (high - low) * 0.5);
  const min = Math.min(low, value) - pad, max = Math.max(high, value) + pad;
  const pct = (n: number) => `${((n - min) / (max - min)) * 100}%`;
  const inRange = value >= low && value <= high;
  return (
    <div className="relative h-2 rounded-full bg-slate-800 my-1.5" aria-hidden>
      <div className="absolute inset-y-0 rounded-full bg-emerald-500/30" style={{ left: pct(low), width: `calc(${pct(high)} - ${pct(low)})` }} />
      <div className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-slate-900 ${inRange ? "bg-emerald-400" : value > high ? "bg-sky-400" : "bg-rose-400"}`} style={{ left: pct(value) }} />
    </div>
  );
}

function Stat({ label, icon, value, sub }: { label: string; icon: string; value: string; sub?: React.ReactNode }) {
  return (
    <div className="relative overflow-hidden rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-4 min-w-0">
      <div className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-purple-500/70 to-transparent" />
      <div className="flex items-center gap-2 min-w-0">
        <span className="h-7 w-7 rounded-lg flex items-center justify-center shrink-0 bg-purple-500/15 text-sm" aria-hidden>{icon}</span>
        <div className="text-xs text-slate-400 truncate">{label}</div>
      </div>
      <div className="text-2xl font-semibold text-slate-100 mt-2 tabular-nums truncate">{value}</div>
      {sub && <div className="text-xs text-slate-400 mt-1.5 space-y-0.5">{sub}</div>}
    </div>
  );
}

// What the chart's tooltip shows for one day.
function DayTooltip({ active, payload }: { active?: boolean; payload?: { payload: { raw: HealthDay } }[] }) {
  const d = active ? payload?.[0]?.payload.raw : null;
  if (!d) return null;
  return (
    <div className="rounded-lg border border-white/10 bg-slate-950/95 px-3 py-2 text-xs space-y-1 shadow-xl">
      <div className="font-semibold text-slate-100">{longDate(d.date)}</div>
      {d.ignored && <div className="text-amber-300">Ignored: left out of the averages and the summary</div>}
      {d.sleepSec != null ? (
        <>
          <div className="text-slate-200">Sleep {hm(d.sleepSec)}{d.sleepScore != null && <span className="text-slate-400"> · score {d.sleepScore}{d.sleepQualifier ? ` (${d.sleepQualifier})` : ""}</span>}</div>
          {d.deepSec != null && (
            <div className="text-slate-400">
              <span style={{ color: C.deep }}>Deep {hm(d.deepSec)}</span> · <span style={{ color: C.rem }}>REM {hm(d.remSec)}</span> · <span style={{ color: C.light }}>Light {hm(d.lightSec)}</span> · Awake {hm(d.awakeSec)}
            </div>
          )}
        </>
      ) : <div className="text-slate-500">No sleep recorded</div>}
      {d.hrv != null ? (
        <div className="text-slate-200">
          HRV <span style={{ color: C.hrv }}>{d.hrv} ms</span>
          {d.hrvWeekly != null && <span className="text-slate-400"> · 7-day avg {d.hrvWeekly}</span>}
          {d.hrvLow != null && d.hrvHigh != null && <span className="text-slate-400"> · baseline {d.hrvLow}–{d.hrvHigh}</span>}
          {d.hrvStatus && <span className={`ml-1 ${statusColor(d.hrvStatus)}`}>{d.hrvStatus}</span>}
        </div>
      ) : <div className="text-slate-500">No HRV reading</div>}
      {d.restingHr != null && <div className="text-slate-400">Resting HR {d.restingHr} bpm</div>}
    </div>
  );
}

export function HealthClient() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set()); // series switched off by clicking the legend
  // Right-clicking the chart opens a menu for the night under the pointer; hoverIdx is the night the pointer is over.
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; date: string } | null>(null);
  const [ignoring, setIgnoring] = useState(false);
  const [nightDate, setNightDate] = useState<string | null>(null); // night shown in the timeline popup

  const load = useCallback(async (n: number) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/health/dashboard?days=${n}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed (${res.status})`);
      setData(body); setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load the health data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(days); }, [days, load]);
  useEffect(() => {
    const t = setInterval(() => load(days), AUTO_REFRESH_MS);
    return () => clearInterval(t);
  }, [days, load]);

  // Ignore (or include again) a night; the page then reloads, so the averages and tiles follow. The AI summary only
  // leaves it out once a fresh one is written (its refresh button).
  async function setIgnored(date: string, ignored: boolean) {
    setMenu(null); setIgnoring(true);
    try {
      const res = await fetch("/api/health/ignore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ date, ignored }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Failed (${res.status})`);
      await load(days);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that");
    } finally {
      setIgnoring(false);
    }
  }

  // The menu closes on any click, scroll, resize or Escape.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const points = useMemo(() => (data?.days ?? []).map(d => {
    const staged = d.deepSec != null || d.lightSec != null || d.remSec != null;
    const ign = d.ignored;
    return {
      label: shortDate(d.date),
      // An ignored night keeps a faded grey bar (so the gap is explained) and has no HRV point.
      deep: ign ? null : hours(d.deepSec), rem: ign ? null : hours(d.remSec), light: ign ? null : hours(d.lightSec),
      unstaged: !ign && !staged ? hours(d.sleepSec) : null, // a night with no stage breakdown (read from Garmin Connect)
      ignoredSleep: ign ? hours(d.sleepSec) : null,
      hrv: ign ? null : d.hrv, hrvWeekly: ign ? null : d.hrvWeekly,
      low: d.hrvLow, band: d.hrvLow != null && d.hrvHigh != null ? d.hrvHigh - d.hrvLow : null,
      raw: d,
    };
  }), [data]);

  const toggle = (key: string) => setHidden(h => { const n = new Set(h); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const rhrNow = data ? [...data.days].reverse().find(d => d.restingHr != null) ?? null : null;
  const hasHrv = !!data?.days.some(d => d.hrv != null);

  return (
    <div className="relative isolate min-h-screen flex flex-col text-slate-100">
      <div aria-hidden className="fixed inset-0 -z-10 bg-slate-950 bg-cover bg-center bg-no-repeat pointer-events-none"
        style={{ backgroundImage: "linear-gradient(rgba(2,6,23,0.85), rgba(2,6,23,0.85)), url('/dashboard-hero.png')" }} />
      <TopNav title="❤️ Health" maxWidth="max-w-[1800px]" />

      <main className="flex-1 max-w-[1800px] w-full mx-auto px-4 py-6 space-y-6">
        {error && <section className="rounded-xl bg-slate-900/85 border border-white/10 p-5"><p className="text-sm text-rose-300">{error}</p></section>}
        {!data && !error && <p className="text-sm text-slate-500">Loading…</p>}

        {data && (
          <>
            {/* Headline numbers */}
            <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
              <Stat label="Last night's sleep" icon="😴" value={hm(data.latestSleep?.sleepSec)}
                sub={data.latestSleep ? (
                  <>
                    {data.latestSleep.sleepScore != null && <div>Score {data.latestSleep.sleepScore}{data.latestSleep.sleepQualifier ? ` · ${data.latestSleep.sleepQualifier}` : ""}</div>}
                    {data.latestSleep.date !== data.today && <div className="text-slate-500">{longDate(data.latestSleep.date)}</div>}
                  </>
                ) : "No sleep recorded yet"} />
              {/* Garmin's Sleep Coach: what it recommends for tonight, against your baseline, and why */}
              <Stat label="Sleep coach · tonight" icon="🧭" value={data.sleepCoach?.tonight ? hm(data.sleepCoach.tonight.needMin * 60) : "—"}
                sub={data.sleepCoach ? (
                  <>
                    {data.sleepCoach.tonight && (
                      <div>
                        <span className={data.sleepCoach.tonight.needMin > data.sleepCoach.tonight.baselineMin ? "text-amber-300" : "text-emerald-300"}>
                          {data.sleepCoach.tonight.change ?? "Recommended"}
                        </span>
                        <span className="text-slate-500"> · baseline {hm(data.sleepCoach.tonight.baselineMin * 60)}</span>
                      </div>
                    )}
                    {data.sleepCoach.tonight && data.sleepCoach.tonight.reasons.length > 0 && (
                      <div className="text-slate-500">Because of {data.sleepCoach.tonight.reasons.join(" and ")}</div>
                    )}
                    {data.sleepCoach.verdict && (
                      <div className={data.sleepCoach.verdictTone === "good" ? "text-emerald-300" : data.sleepCoach.verdictTone === "poor" ? "text-rose-300" : "text-slate-300"}>
                        Last night: {data.sleepCoach.verdict.toLowerCase()}
                      </div>
                    )}
                  </>
                ) : "Garmin's recommendation isn't available yet"} />
              <Stat label="Sleep · last 7 nights" icon="🛏️" value={hm(data.avg7.sleepSec)}
                sub={<><div>Average per night{data.avg7.sleepScore != null ? ` · score ${Math.round(data.avg7.sleepScore)}` : ""}</div>
                  <div className="text-slate-500">{days}-day average {hm(data.avgAll.sleepSec)}</div></>} />
              {/* HRV last night, against the baseline range Garmin works out from your own history */}
              {(() => {
                const h = data.latestHrv;
                const v = h?.hrv != null ? hrvVerdict(h.hrv, h.hrvLow, h.hrvHigh) : null;
                return (
                  <Stat label="HRV · last night" icon="💓" value={h?.hrv != null ? `${h.hrv} ms` : "—"}
                    sub={h ? (
                      <>
                        {v && <div className={`font-medium ${v.color}`}>{v.icon} {v.label}</div>}
                        {h.hrv != null && h.hrvLow != null && h.hrvHigh != null && <HrvGauge value={h.hrv} low={h.hrvLow} high={h.hrvHigh} />}
                        {h.hrvLow != null && h.hrvHigh != null && <div className="text-slate-500">Your range {h.hrvLow}–{h.hrvHigh} ms</div>}
                      </>
                    ) : (data.hrvAvailable ? "No HRV reading yet" : "Needs the Garmin Personal API (Settings → Garmin)")} />
                );
              })()}
              {/* The 7-day average is what Garmin's own status (Balanced, Unbalanced…) is judged on */}
              {(() => {
                const h = data.latestHrv;
                const weekly = h?.hrvWeekly ?? (data.avg7.hrv != null ? Math.round(data.avg7.hrv) : null);
                const v = weekly != null ? hrvVerdict(weekly, h?.hrvLow ?? null, h?.hrvHigh ?? null) : null;
                return (
                  <Stat label="HRV · 7-day average" icon="📈" value={weekly != null ? `${weekly} ms` : "—"}
                    sub={<>
                      {v && <div className={`font-medium ${v.color}`}>{v.icon} {v.label}</div>}
                      {h?.hrvStatus && <div className={statusColor(h.hrvStatus)}>Garmin: {h.hrvStatus}</div>}
                      {data.avgAll.hrv != null && <div className="text-slate-500">{days}-day average {Math.round(data.avgAll.hrv)} ms</div>}
                    </>} />
                );
              })()}
              <Stat label="Resting heart rate" icon="❤️" value={rhrNow?.restingHr != null ? `${rhrNow.restingHr} bpm` : "—"}
                sub={<>{rhrNow && rhrNow.date !== data.today && <div className="text-slate-500">{longDate(rhrNow.date)}</div>}
                  {data.avgAll.restingHr != null && <div className="text-slate-500">{days}-day average {Math.round(data.avgAll.restingHr)} bpm</div>}</>} />
            </div>

            {/* The chart: a month of sleep (stages) and HRV */}
            <section className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5">
              <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                <h2 className="flex items-center gap-2.5 text-sm font-semibold text-slate-100">
                  <span className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0 bg-purple-500/15 text-base" aria-hidden>🌙</span>
                  Sleep and HRV
                  {loading && <span className="text-xs font-normal text-slate-500">loading…</span>}
                </h2>
                <div className="flex gap-1.5">
                  {RANGES.map(r => (
                    <button key={r} onClick={() => setDays(r)}
                      className={`rounded-lg border text-xs font-semibold px-2.5 py-1.5 transition-colors ${
                        days === r ? "bg-purple-500/20 border-purple-500/50 text-purple-200" : "bg-slate-800/60 border-white/10 text-slate-400 hover:text-slate-200"
                      }`}>
                      {r}d
                    </button>
                  ))}
                </div>
              </div>

              {!hasHrv && !data.days.some(d => d.sleepSec != null) ? (
                <p className="text-sm text-slate-500">No sleep or HRV data from Garmin yet.</p>
              ) : (
                <div onContextMenu={e => {
                  if (hoverIdx == null || !points[hoverIdx]) return; // not over a night: leave the browser's own menu
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, date: points[hoverIdx].raw.date });
                }}>
                <ResponsiveContainer width="100%" height={360}>
                  <ComposedChart data={points} margin={{ top: 8, right: 4, left: 0, bottom: 0 }} style={{ cursor: "pointer" }}
                    onClick={(s: { activeTooltipIndex?: number }) => {
                      const p = typeof s?.activeTooltipIndex === "number" ? points[s.activeTooltipIndex] : null;
                      if (p && p.raw.sleepSec != null) setNightDate(p.raw.date);
                    }}
                    onMouseMove={(s: { activeTooltipIndex?: number }) => setHoverIdx(typeof s?.activeTooltipIndex === "number" ? s.activeTooltipIndex : null)}
                    onMouseLeave={() => setHoverIdx(null)}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                    <XAxis dataKey="label" tick={{ fill: C.axis, fontSize: 10 }} axisLine={{ stroke: C.grid }} tickLine={false} minTickGap={days > 30 ? 28 : 14} />
                    <YAxis yAxisId="sleep" domain={[0, (max: number) => Math.max(9, Math.ceil(max))]} tickFormatter={v => `${v}h`}
                      tick={{ fill: C.axis, fontSize: 10 }} axisLine={false} tickLine={false} width={34} />
                    <YAxis yAxisId="hrv" orientation="right" domain={[(min: number) => Math.floor(min - 8), (max: number) => Math.ceil(max + 8)]} allowDecimals={false}
                      tickFormatter={v => `${v}`} tick={{ fill: C.hrv, fontSize: 10 }} axisLine={false} tickLine={false} width={30} />
                    <Tooltip content={<DayTooltip />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
                    <Legend wrapperStyle={{ fontSize: 11, color: C.axis, cursor: "pointer" }}
                      onClick={e => toggle(String(e.dataKey))}
                      formatter={(value, entry) => <span style={{ opacity: hidden.has(String((entry as { dataKey?: string }).dataKey)) ? 0.35 : 1 }}>{value}</span>} />

                    {/* Garmin's "balanced" HRV band: a transparent base up to the low edge, then the band itself */}
                    <Area yAxisId="hrv" dataKey="low" stackId="band" stroke="none" fill="transparent" legendType="none" isAnimationActive={false} activeDot={false} />
                    <Area yAxisId="hrv" dataKey="band" name="HRV baseline (balanced)" stackId="band" stroke="none" fill={C.band} fillOpacity={0.14}
                      hide={hidden.has("band")} isAnimationActive={false} activeDot={false} />

                    {/* Sleep, by stage, in hours */}
                    <Bar yAxisId="sleep" dataKey="deep" name="Deep" stackId="sleep" fill={C.deep} hide={hidden.has("deep")} isAnimationActive={false} />
                    <Bar yAxisId="sleep" dataKey="rem" name="REM" stackId="sleep" fill={C.rem} hide={hidden.has("rem")} isAnimationActive={false} />
                    <Bar yAxisId="sleep" dataKey="light" name="Light" stackId="sleep" fill={C.light} hide={hidden.has("light")} isAnimationActive={false} />
                    <Bar yAxisId="sleep" dataKey="unstaged" name="Sleep (no stages)" stackId="sleep" fill={C.unstaged} hide={hidden.has("unstaged")} isAnimationActive={false}
                      legendType={points.some(p => p.unstaged != null) ? "square" : "none"} />
                    <Bar yAxisId="sleep" dataKey="ignoredSleep" name="Ignored night" stackId="sleep" fill="#94a3b8" fillOpacity={0.22} stroke="#94a3b8" strokeDasharray="3 3"
                      hide={hidden.has("ignoredSleep")} isAnimationActive={false} legendType={points.some(p => p.ignoredSleep != null) ? "square" : "none"} />

                    {/* HRV */}
                    <Line yAxisId="hrv" dataKey="hrvWeekly" name="HRV 7-day avg" stroke={C.hrvAvg} strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls
                      hide={hidden.has("hrvWeekly")} isAnimationActive={false} />
                    <Line yAxisId="hrv" dataKey="hrv" name="HRV (nightly)" stroke={C.hrv} strokeWidth={2.5} dot={{ r: 3, fill: C.hrv, stroke: "none" }} activeDot={{ r: 5 }} connectNulls={false}
                      hide={hidden.has("hrv")} isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
                </div>
              )}

              {/* Ignored nights, each with a way to bring it back (right-click isn't available on a touch screen) */}
              {data.days.some(d => d.ignored) ? (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-slate-500">Ignored nights:</span>
                  {data.days.filter(d => d.ignored).map(d => (
                    <button key={d.date} onClick={() => setIgnored(d.date, false)} disabled={ignoring} title="Include this night again"
                      className="rounded-full border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 disabled:opacity-50 text-amber-200 px-2.5 py-0.5 transition-colors">
                      {shortDate(d.date)} ✕
                    </button>
                  ))}
                  <span className="text-slate-600">left out of the averages and the AI summary (refresh the summary to apply)</span>
                </div>
              ) : (
                <p className="mt-2 text-[11px] text-slate-600">Right-click a night to ignore it, for example if the watch came off in the night.</p>
              )}

              <details className="mt-3 group">
                <summary className="cursor-pointer select-none text-[11px] text-slate-500 hover:text-slate-300 transition-colors list-none">
                  <span className="inline-block transition-transform group-open:rotate-90 mr-1">▸</span>How to read this chart
                </summary>
                <div className="text-xs text-slate-500 mt-2 space-y-1 leading-relaxed">
                  <p>
                    Each bar is a night&apos;s sleep (filed under the morning you woke), split into deep, REM and light sleep on the left-hand axis in hours. Awake time
                    isn&apos;t counted. The amber line is your overnight heart rate variability on the right-hand axis; the dashed orange line is Garmin&apos;s
                    7-day average of it, and the green band is the range Garmin treats as your normal (&quot;balanced&quot;) HRV, worked out from your own history.
                  </p>
                  <p>
                    Higher HRV than usual generally means you&apos;re well recovered; a run of nights below the band, especially with poor sleep, suggests extra fatigue,
                    stress or illness. Click an item in the legend to hide or show it, and hover a day for its figures, or click a night to open its timeline.
                  </p>
                  {!data.hrvAvailable && <p className="text-amber-300">HRV isn&apos;t available: it needs the Garmin Personal API to be set up.</p>}
                </div>
              </details>
              {data.sources.garminDb && (
                <p className="text-[11px] text-slate-600 mt-2">
                  Sleep from GarminDB, last updated {new Date(data.sources.garminDb).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}; HRV from the Garmin Personal API.
                </p>
              )}
            </section>

            {nightDate && <SleepTimelineModal date={nightDate} onClose={() => setNightDate(null)} />}

            {menu && createPortal(
              <div role="menu" onClick={e => e.stopPropagation()}
                style={{ left: Math.min(menu.x, window.innerWidth - 230), top: Math.min(menu.y, window.innerHeight - 90) }}
                className="fixed z-50 min-w-[210px] rounded-lg border border-white/10 bg-slate-900/95 backdrop-blur-sm shadow-xl py-1 text-xs">
                {(() => {
                  const d = data.days.find(x => x.date === menu.date);
                  const ignored = !!d?.ignored;
                  return (
                    <>
                      <div className="px-3 py-1.5 text-slate-500 border-b border-white/10">Night of {longDate(menu.date)}</div>
                      <button role="menuitemcheckbox" aria-checked={ignored} onClick={() => setIgnored(menu.date, !ignored)}
                        className="flex w-full items-center gap-2 text-left px-3 py-1.5 text-slate-200 hover:bg-slate-700/60">
                        <span className={`inline-flex h-4 w-4 items-center justify-center rounded border ${ignored ? "bg-amber-500/30 border-amber-400 text-amber-200" : "border-slate-500"}`}>{ignored ? "✓" : ""}</span>
                        Ignore this night
                      </button>
                    </>
                  );
                })()}
              </div>,
              document.body,
            )}

            {/* AI summary */}
            <AiSummaryPanel endpoint="/api/health/summary" pill="last 30 days" storageKey="health.summaryCollapsed" subject="sleep and HRV" />
          </>
        )}
      </main>
    </div>
  );
}
