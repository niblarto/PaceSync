"use client";

import { TopNav } from "@/components/TopNav";
import { MetricsLive } from "@/components/MetricsLive";
import { Sortable, resetMetricsLayout } from "@/components/Sortable";
import { formatWeight, LB_PER_KG } from "@/lib/weight-format";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Area, Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

// The Metrics page: a Grafana-style dashboard of running and health data for the last 7-30 days — sleep, HRV, resting
// HR, stress, Body Battery, steps, heart-rate and stress heatmaps, calories in vs out, weight, and each run/walk with
// its pace, heart rate and time in HR zones. Mirrors lib/metrics-dashboard.ts.
interface MetricsDay {
  date: string; steps: number | null; stepGoal: number | null; distanceMi: number | null;
  rhr: number | null; hrMin: number | null; hrMax: number | null; stressAvg: number | null; bbMax: number | null; bbMin: number | null;
  spo2Avg: number | null; rrAvg: number | null; caloriesTotal: number | null; caloriesActive: number | null; caloriesBmr: number | null;
  moderateMin: number | null; vigorousMin: number | null; weightLb: number | null;
  kcalIn: number | null; proteinG: number | null; carbsG: number | null; fatG: number | null;
}
interface HealthDay {
  date: string; sleepSec: number | null; deepSec: number | null; lightSec: number | null; remSec: number | null; awakeSec: number | null;
  sleepScore: number | null; hrv: number | null; hrvWeekly: number | null; restingHr: number | null; ignored: boolean;
}
interface Activity {
  id: string; date: string; startTime: string; sport: string; name: string | null; distanceMi: number | null; movingSec: number | null;
  paceSec: number | null; avgHr: number | null; maxHr: number | null; cadence: number | null; ascentFt: number | null; trainingEffect: number | null; anaerobicEffect: number | null; trainingLoad: number | null; zoneSec: number[];
}
interface HeatCell { date: string; hour: number; value: number }
interface Overview {
  from: string; to: string; days: MetricsDay[]; health: HealthDay[]; activities: Activity[]; hrHeat: HeatCell[]; stressHeat: HeatCell[];
  weight: { kg: number; date: string; avg7Kg: number; postRun: boolean } | null;
}
interface DayDetail { date: string; points: { t: string; hr: number | null; stress: number | null }[]; activities: Activity[] }

const RANGES = [7, 14, 30];
const C = {
  deep: "#4f46e5", rem: "#a855f7", light: "#38bdf8", hrv: "#fbbf24", rhr: "#fb7185", stress: "#f97316", bb: "#34d399", bbLow: "#0ea5e9",
  steps: "#38bdf8", goal: "#94a3b8", kcalIn: "#a78bfa", burn: "#f97316", weight: "#22d3ee", axis: "#64748b", grid: "rgba(255,255,255,0.05)",
  z: ["#64748b", "#38bdf8", "#34d399", "#fbbf24", "#f43f5e"],
};

const shortDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const dayLabel = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric" });
const hoursOf = (sec: number | null) => (sec == null ? null : Math.round(sec / 36) / 100);
const hm = (sec: number | null | undefined) => (sec == null ? "—" : `${Math.floor(sec / 3600)}h ${String(Math.round((sec % 3600) / 60)).padStart(2, "0")}m`);
const pace = (sec: number | null | undefined) => (sec == null ? "—" : `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`);
const mean = (xs: (number | null | undefined)[]) => {
  const v = xs.filter((x): x is number => typeof x === "number");
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
// Weights come from Garmin in lb; shown as stones and pounds, e.g. "12 st 13.5 lb".
const stLb = (lb: number | null | undefined) => (lb == null ? "—" : formatWeight(lb / LB_PER_KG, "st", { exact: true }));
const stLbShort = (lb: number) => { const t = Math.round(lb * 10) / 10; const st = Math.floor(t / 14); return `${st}st ${(t - st * 14).toFixed(0)}`; };
const stLbDelta = (lb: number) => `${lb > 0 ? "+" : lb < 0 ? "−" : ""}${Math.abs(lb).toFixed(1)} lb`;
const fix = (v: number | null, d = 0) => (v == null ? "—" : v.toFixed(d));

const tick = { fill: C.axis, fontSize: 10 };
const tip = { contentStyle: { background: "rgba(2,6,23,0.95)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12 }, labelStyle: { color: "#e2e8f0" } };

function Panel({ title, icon, sub, children, className = "" }: { title: string; icon: string; sub?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-4 ${className}`}>
      <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-100 mb-0.5"><span aria-hidden>{icon}</span>{title}</h2>
      {sub && <p className="text-[11px] text-slate-500 mb-2">{sub}</p>}
      <div className={sub ? "" : "mt-2"}>{children}</div>
    </section>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl bg-slate-900/85 border border-white/10 px-4 py-3">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className="text-xl font-semibold text-slate-100 tabular-nums">{value}</p>
      {sub && <p className="text-[11px] text-slate-500">{sub}</p>}
    </div>
  );
}

// Hour-by-day heatmap (SVG): one row per day, one column per hour of the day.
function Heatmap({ dates, cells, lo, hi, hue, unit, onPickDate }: {
  dates: string[]; cells: HeatCell[]; lo: number; hi: number; hue: (f: number) => number; unit: string; onPickDate: (d: string) => void;
}) {
  const [hover, setHover] = useState<HeatCell | null>(null);
  const L = 54, T = 4, cw = 36, ch = Math.max(10, Math.min(20, Math.floor(300 / dates.length)));
  const W = L + 24 * cw, H = T + dates.length * ch + 18;
  const map = useMemo(() => new Map(cells.map(c => [`${c.date}|${c.hour}`, c.value])), [cells]);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full select-none">
        {dates.map((d, r) => (
          <g key={d}>
            <text x={L - 6} y={T + r * ch + ch / 2 + 3} textAnchor="end" fontSize="9" fill={C.axis} className="cursor-pointer" onClick={() => onPickDate(d)}>{dayLabel(d)}</text>
            {Array.from({ length: 24 }, (_, h) => {
              const v = map.get(`${d}|${h}`);
              return (
                <rect key={h} x={L + h * cw + 1} y={T + r * ch + 1} width={cw - 2} height={ch - 2} rx={2}
                  fill={v == null ? "rgba(255,255,255,0.03)" : `hsl(${hue(Math.min(1, Math.max(0, (v - lo) / (hi - lo))))} 70% 50%)`}
                  onMouseEnter={() => v != null && setHover({ date: d, hour: h, value: v })} onMouseLeave={() => setHover(null)} />
              );
            })}
          </g>
        ))}
        {[0, 3, 6, 9, 12, 15, 18, 21].map(h => (
          <text key={h} x={L + h * cw + cw / 2} y={H - 4} textAnchor="middle" fontSize="9" fill={C.axis}>{String(h).padStart(2, "0")}</text>
        ))}
      </svg>
      <p className="text-[11px] text-slate-500 h-4">
        {hover ? `${dayLabel(hover.date)} ${String(hover.hour).padStart(2, "0")}:00 — ${hover.value} ${unit}` : "Hover a cell; click a day to see it minute by minute below."}
      </p>
    </div>
  );
}

export function MetricsClient() {
  const [days, setDays] = useState(14);
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pick, setPick] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);       // rearranging the boxes
  const [layoutVersion, setLayoutVersion] = useState(0); // bumped by "Reset layout"
  const [detail, setDetail] = useState<DayDetail | null>(null);

  const load = useCallback(async (n: number) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/metrics/overview?days=${n}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed (${res.status})`);
      setData(body); setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load the metrics");
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(days); }, [days, load]);

  useEffect(() => {
    if (!pick) { setDetail(null); return; }
    let live = true;
    fetch(`/api/metrics/day?date=${pick}`).then(r => r.json()).then((d: DayDetail) => { if (live) setDetail(d); }).catch(() => {});
    return () => { live = false; };
  }, [pick]);
  useEffect(() => { if (data && !pick) setPick(data.to); }, [data, pick]);

  const dates = useMemo(() => (data?.days ?? []).map(d => d.date), [data]);
  const health = useMemo(() => new Map((data?.health ?? []).map(h => [h.date, h])), [data]);

  const rows = useMemo(() => (data?.days ?? []).map(d => {
    const h = health.get(d.date);
    const ok = h && !h.ignored;
    return {
      label: shortDate(d.date), date: d.date,
      deep: ok ? hoursOf(h.deepSec) : null, rem: ok ? hoursOf(h.remSec) : null, light: ok ? hoursOf(h.lightSec) : null,
      score: ok ? h.sleepScore : null,
      hrv: ok ? h.hrv : null, hrvWeekly: ok ? h.hrvWeekly : null, rhr: d.rhr ?? h?.restingHr ?? null,
      stress: d.stressAvg, bbMax: d.bbMax, bbMin: d.bbMin,
      steps: d.steps, goal: d.stepGoal,
      kcalIn: d.kcalIn, burn: d.caloriesTotal, active: d.caloriesActive, weight: d.weightLb,
    };
  }), [data, health]);

  const runs = (data?.activities ?? []).filter(a => /running/i.test(a.sport));
  const walks = (data?.activities ?? []).filter(a => /walking/i.test(a.sport));
  const runRows = runs.map(a => ({
    label: shortDate(a.date), name: a.name ?? "Run", paceSec: a.paceSec, hr: a.avgHr, cadence: a.cadence, miles: a.distanceMi,
    z1: Math.round(a.zoneSec[0] / 60), z2: Math.round(a.zoneSec[1] / 60), z3: Math.round(a.zoneSec[2] / 60), z4: Math.round(a.zoneSec[3] / 60), z5: Math.round(a.zoneSec[4] / 60),
  }));
  const hasZones = runRows.some(r => r.z1 + r.z2 + r.z3 + r.z4 + r.z5 > 0);

  const sleepAvg = mean((data?.health ?? []).filter(h => !h.ignored).map(h => h.sleepSec));
  const wLast = [...rows].reverse().find(r => r.weight != null)?.weight ?? null;
  const wFirst = rows.find(r => r.weight != null)?.weight ?? null;

  const teNode = data ? (
            <Panel key="effect" title="Training effect" icon="💪" sub="Aerobic and anaerobic training effect (0–5) of each run and walk, with Garmin's training load">
              {data.activities.length === 0 ? <p className="text-sm text-slate-500">No activities in this range.</p> : (
                <ResponsiveContainer width="100%" height={240}>
                  <ComposedChart data={data.activities.map(a => ({ label: `${dayLabel(a.date)} ${/running/i.test(a.sport) ? "🏃" : "🚶"}`, aerobic: a.trainingEffect, anaerobic: a.anaerobicEffect, load: a.trainingLoad }))} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                    <XAxis dataKey="label" tick={tick} axisLine={{ stroke: C.grid }} tickLine={false} />
                    <YAxis yAxisId="te" domain={[0, 5]} tick={tick} axisLine={false} tickLine={false} width={26} />
                    <YAxis yAxisId="ld" orientation="right" tick={{ ...tick, fill: C.burn }} axisLine={false} tickLine={false} width={34} />
                    <Tooltip {...tip} />
                    <Legend wrapperStyle={{ fontSize: 11, color: C.axis }} />
                    <Bar yAxisId="te" dataKey="aerobic" name="Aerobic TE" fill={C.bb} radius={[3, 3, 0, 0]} isAnimationActive={false} />
                    <Bar yAxisId="te" dataKey="anaerobic" name="Anaerobic TE" fill={C.rem} radius={[3, 3, 0, 0]} isAnimationActive={false} />
                    <Line yAxisId="ld" dataKey="load" name="Training load" stroke={C.burn} strokeWidth={2} dot={{ r: 3 }} connectNulls isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </Panel>
  ) : null;

  return (
    <div className="relative isolate min-h-screen flex flex-col text-slate-100">
      <div aria-hidden className="fixed inset-0 -z-10 bg-slate-950 bg-cover bg-center bg-no-repeat pointer-events-none"
        style={{ backgroundImage: "linear-gradient(rgba(2,6,23,0.85), rgba(2,6,23,0.85)), url('/dashboard-hero.png')" }} />
      <TopNav title="📊 Metrics" maxWidth="max-w-[1800px]" />

      <main className="flex-1 max-w-[1800px] w-full mx-auto px-4 py-6 space-y-4">
        <MetricsLive onRefreshed={() => load(days)} trainingEffect={teNode} editing={editing} onToggleEdit={() => setEditing(e => !e)}
          onResetLayout={() => { resetMetricsLayout(); setLayoutVersion(v => v + 1); }} layoutVersion={layoutVersion} />
        <h2 className="text-sm font-semibold text-slate-300 pt-2">Trends</h2>
        <div className="flex items-center justify-between">
          <p className="text-xs text-slate-500">{data ? `${shortDate(data.from)} – ${shortDate(data.to)}` : ""}{loading && " · loading…"}</p>
          <div className="flex gap-1.5">
            {RANGES.map(r => (
              <button key={r} onClick={() => setDays(r)}
                className={`rounded-lg border text-xs font-semibold px-2.5 py-1.5 transition-colors ${days === r ? "bg-purple-500/20 border-purple-500/50 text-purple-200" : "bg-slate-800/60 border-white/10 text-slate-400 hover:text-slate-200"}`}>
                {r}d
              </button>
            ))}
          </div>
        </div>

        {error && <section className="rounded-xl bg-slate-900/85 border border-white/10 p-5"><p className="text-sm text-rose-300">{error}</p></section>}
        {!data && !error && <p className="text-sm text-slate-500">Loading…</p>}

        {data && (
          <>
            <Sortable section="trend-tiles" editing={editing} layoutVersion={layoutVersion} className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
              <Tile key="rhr" label="Resting HR" value={`${fix(mean(rows.map(r => r.rhr)))} bpm`} sub="average" />
              <Tile key="hrv" label="HRV" value={`${fix(mean(rows.map(r => r.hrv)))} ms`} sub="average" />
              <Tile key="sleep" label="Sleep" value={hm(sleepAvg)} sub={`score ${fix(mean(rows.map(r => r.score)))}`} />
              <Tile key="steps" label="Steps" value={fix(mean(rows.map(r => r.steps))).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} sub="per day" />
              <Tile key="stress" label="Stress" value={fix(mean(rows.map(r => r.stress)))} sub="average" />
              <Tile key="running" label="Running" value={`${fix(runs.reduce((a, r) => a + (r.distanceMi ?? 0), 0), 1)} mi`} sub={`${runs.length} run${runs.length === 1 ? "" : "s"} · ${walks.length} walk${walks.length === 1 ? "" : "s"}`} />
              <Tile key="eaten" label="Eaten" value={`${fix(mean(rows.map(r => r.kcalIn)))} kcal`} sub="per logged day" />
              <Tile key="weight" label="Weight" value={data.weight ? formatWeight(data.weight.kg, "st", { exact: true }) : stLb(wLast)}
                sub={wLast != null && wFirst != null ? `${stLbDelta(wLast - wFirst)} over the range` : data.weight ? shortDate(data.weight.date) : undefined} />
            </Sortable>

            <Sortable section="trend-panels" editing={editing} layoutVersion={layoutVersion} className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <Panel key="sleep" title="Sleep" icon="🌙" sub="Hours by stage, with the sleep score">
                <ResponsiveContainer width="100%" height={240}>
                  <ComposedChart data={rows} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                    <XAxis dataKey="label" tick={tick} axisLine={{ stroke: C.grid }} tickLine={false} minTickGap={14} />
                    <YAxis yAxisId="h" tick={tick} axisLine={false} tickLine={false} width={30} tickFormatter={v => `${v}h`} />
                    <YAxis yAxisId="s" orientation="right" domain={[40, 100]} tick={{ ...tick, fill: C.hrv }} axisLine={false} tickLine={false} width={28} />
                    <Tooltip {...tip} />
                    <Legend wrapperStyle={{ fontSize: 11, color: C.axis }} />
                    <Bar yAxisId="h" dataKey="deep" name="Deep" stackId="s" fill={C.deep} isAnimationActive={false} />
                    <Bar yAxisId="h" dataKey="rem" name="REM" stackId="s" fill={C.rem} isAnimationActive={false} />
                    <Bar yAxisId="h" dataKey="light" name="Light" stackId="s" fill={C.light} isAnimationActive={false} />
                    <Line yAxisId="s" dataKey="score" name="Score" stroke={C.hrv} strokeWidth={2} dot={{ r: 2.5 }} connectNulls isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </Panel>

              <Panel key="rhr-hrv" title="Resting heart rate and HRV" icon="💓" sub="Lower resting HR and higher HRV generally mean better recovery">
                <ResponsiveContainer width="100%" height={240}>
                  <ComposedChart data={rows} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                    <XAxis dataKey="label" tick={tick} axisLine={{ stroke: C.grid }} tickLine={false} minTickGap={14} />
                    <YAxis yAxisId="r" domain={["dataMin - 3", "dataMax + 3"]} tick={{ ...tick, fill: C.rhr }} axisLine={false} tickLine={false} width={30} allowDecimals={false} />
                    <YAxis yAxisId="v" orientation="right" domain={["dataMin - 6", "dataMax + 6"]} tick={{ ...tick, fill: C.hrv }} axisLine={false} tickLine={false} width={30} allowDecimals={false} />
                    <Tooltip {...tip} />
                    <Legend wrapperStyle={{ fontSize: 11, color: C.axis }} />
                    <Line yAxisId="r" dataKey="rhr" name="Resting HR (bpm)" stroke={C.rhr} strokeWidth={2.5} dot={{ r: 3 }} connectNulls isAnimationActive={false} />
                    <Line yAxisId="v" dataKey="hrv" name="HRV (ms)" stroke={C.hrv} strokeWidth={2.5} dot={{ r: 3 }} connectNulls isAnimationActive={false} />
                    <Line yAxisId="v" dataKey="hrvWeekly" name="HRV 7-day avg" stroke={C.hrv} strokeDasharray="5 4" dot={false} connectNulls isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </Panel>

              <Panel key="stress-bb" title="Stress and Body Battery" icon="🔋" sub="Average stress (0–100) against the day's Body Battery high and low">
                <ResponsiveContainer width="100%" height={240}>
                  <ComposedChart data={rows} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                    <XAxis dataKey="label" tick={tick} axisLine={{ stroke: C.grid }} tickLine={false} minTickGap={14} />
                    <YAxis domain={[0, 100]} tick={tick} axisLine={false} tickLine={false} width={30} />
                    <Tooltip {...tip} />
                    <Legend wrapperStyle={{ fontSize: 11, color: C.axis }} />
                    <Area dataKey="stress" name="Stress" stroke={C.stress} fill={C.stress} fillOpacity={0.15} strokeWidth={2} connectNulls isAnimationActive={false} />
                    <Line dataKey="bbMax" name="Body Battery high" stroke={C.bb} strokeWidth={2} dot={{ r: 2.5 }} connectNulls isAnimationActive={false} />
                    <Line dataKey="bbMin" name="Body Battery low" stroke={C.bbLow} strokeWidth={2} dot={{ r: 2.5 }} connectNulls isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </Panel>

              <Panel key="steps" title="Steps" icon="👟" sub="Daily steps against your goal">
                <ResponsiveContainer width="100%" height={240}>
                  <ComposedChart data={rows} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                    <XAxis dataKey="label" tick={tick} axisLine={{ stroke: C.grid }} tickLine={false} minTickGap={14} />
                    <YAxis tick={tick} axisLine={false} tickLine={false} width={38} />
                    <Tooltip {...tip} />
                    <Legend wrapperStyle={{ fontSize: 11, color: C.axis }} />
                    <Bar dataKey="steps" name="Steps" fill={C.steps} radius={[3, 3, 0, 0]} isAnimationActive={false} />
                    <Line dataKey="goal" name="Goal" stroke={C.goal} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </Panel>

              <Panel key="hr-heat" title="Heart rate by hour" icon="❤️" sub="Average heart rate, by day and hour (bpm)">
                <Heatmap dates={dates} cells={data.hrHeat} lo={45} hi={140} hue={f => 215 - f * 215} unit="bpm" onPickDate={setPick} />
              </Panel>

              <Panel key="stress-heat" title="Stress by hour" icon="🌡️" sub="Average stress, by day and hour (0–100)">
                <Heatmap dates={dates} cells={data.stressHeat} lo={10} hi={70} hue={f => 150 - f * 150} unit="stress" onPickDate={setPick} />
              </Panel>

              <Panel key="calories" title="Calories in and out" icon="🍽️" sub="Lose It! food diary against Garmin's total burn (rest + active)">
                <ResponsiveContainer width="100%" height={240}>
                  <ComposedChart data={rows} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                    <XAxis dataKey="label" tick={tick} axisLine={{ stroke: C.grid }} tickLine={false} minTickGap={14} />
                    <YAxis tick={tick} axisLine={false} tickLine={false} width={38} />
                    <Tooltip {...tip} />
                    <Legend wrapperStyle={{ fontSize: 11, color: C.axis }} />
                    <Bar dataKey="kcalIn" name="Eaten (kcal)" fill={C.kcalIn} radius={[3, 3, 0, 0]} isAnimationActive={false} />
                    <Line dataKey="burn" name="Burned (kcal)" stroke={C.burn} strokeWidth={2.5} dot={{ r: 2.5 }} connectNulls isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </Panel>

              <Panel key="weight" title="Weight" icon="⚖️" sub="Garmin weigh-ins, in stones and pounds">
                <ResponsiveContainer width="100%" height={240}>
                  <ComposedChart data={rows} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                    <XAxis dataKey="label" tick={tick} axisLine={{ stroke: C.grid }} tickLine={false} minTickGap={14} />
                    <YAxis domain={["dataMin - 1", "dataMax + 1"]} tick={tick} axisLine={false} tickLine={false} width={46} tickFormatter={v => stLbShort(Number(v))} />
                    <Tooltip {...tip} formatter={(v) => [stLb(Number(v)), "Weight"]} />
                    <Line dataKey="weight" name="Weight" stroke={C.weight} strokeWidth={2.5} dot={{ r: 3 }} connectNulls isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </Panel>
            </Sortable>

            <Sortable section="trend-wide" editing={editing} layoutVersion={layoutVersion} className="space-y-4">
            <Panel key="running" title="Running" icon="🏃" sub={`${runs.length} run${runs.length === 1 ? "" : "s"} and ${walks.length} walk${walks.length === 1 ? "" : "s"} in this range`}>
              {runs.length === 0 ? <p className="text-sm text-slate-500">No runs in this range.</p> : (
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  <div>
                    <p className="text-[11px] text-slate-500 mb-1">Pace and heart rate per run (faster pace is higher)</p>
                    <ResponsiveContainer width="100%" height={240}>
                      <ComposedChart data={runRows} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                        <XAxis dataKey="label" tick={tick} axisLine={{ stroke: C.grid }} tickLine={false} />
                        <YAxis yAxisId="p" reversed domain={["dataMin - 15", "dataMax + 15"]} tickFormatter={v => pace(Number(v))} tick={{ ...tick, fill: C.steps }} axisLine={false} tickLine={false} width={38} />
                        <YAxis yAxisId="h" orientation="right" domain={["dataMin - 5", "dataMax + 5"]} tick={{ ...tick, fill: C.rhr }} axisLine={false} tickLine={false} width={30} allowDecimals={false} />
                        <Tooltip {...tip} formatter={(v, n) => (n === "Pace (/mi)" ? [pace(Number(v)), n] : [v, n])} />
                        <Legend wrapperStyle={{ fontSize: 11, color: C.axis }} />
                        <Bar yAxisId="p" dataKey="paceSec" name="Pace (/mi)" fill={C.steps} fillOpacity={0.55} radius={[3, 3, 0, 0]} isAnimationActive={false} />
                        <Line yAxisId="h" dataKey="hr" name="Avg HR (bpm)" stroke={C.rhr} strokeWidth={2.5} dot={{ r: 3 }} isAnimationActive={false} />
                        <Line yAxisId="h" dataKey="cadence" name="Cadence (spm)" stroke={C.bb} strokeWidth={2} dot={{ r: 2.5 }} isAnimationActive={false} hide />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-500 mb-1">Minutes in each heart-rate zone</p>
                    {hasZones ? (
                      <ResponsiveContainer width="100%" height={240}>
                        <ComposedChart data={runRows} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                          <XAxis dataKey="label" tick={tick} axisLine={{ stroke: C.grid }} tickLine={false} />
                          <YAxis tick={tick} axisLine={false} tickLine={false} width={30} />
                          <Tooltip {...tip} />
                          <Legend wrapperStyle={{ fontSize: 11, color: C.axis }} />
                          {([1, 2, 3, 4, 5] as const).map(z => (
                            <Bar key={z} dataKey={`z${z}`} name={`Zone ${z}`} stackId="z" fill={C.z[z - 1]} isAnimationActive={false} />
                          ))}
                        </ComposedChart>
                      </ResponsiveContainer>
                    ) : <p className="text-sm text-slate-500">No heart-rate zone data for these runs.</p>}
                  </div>
                </div>
              )}
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-slate-500 border-b border-white/10">
                      <th className="py-1.5 pr-3 font-medium">Date</th><th className="pr-3 font-medium">Activity</th><th className="pr-3 font-medium text-right">Miles</th>
                      <th className="pr-3 font-medium text-right">Time</th><th className="pr-3 font-medium text-right">Pace</th><th className="pr-3 font-medium text-right">Avg HR</th>
                      <th className="pr-3 font-medium text-right">Cadence</th><th className="pr-3 font-medium text-right">Ascent</th><th className="font-medium text-right">TE</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.activities.slice().reverse().map(a => (
                      <tr key={a.id} className="border-b border-white/5 text-slate-300 hover:bg-white/5 cursor-pointer" onClick={() => setPick(a.date)}>
                        <td className="py-1.5 pr-3 whitespace-nowrap">{dayLabel(a.date)}</td>
                        <td className="pr-3 max-w-[260px] truncate">{/running/i.test(a.sport) ? "🏃" : "🚶"} {a.name ?? a.sport}</td>
                        <td className="pr-3 text-right tabular-nums">{fix(a.distanceMi, 2)}</td>
                        <td className="pr-3 text-right tabular-nums">{hm(a.movingSec)}</td>
                        <td className="pr-3 text-right tabular-nums">{pace(a.paceSec)}</td>
                        <td className="pr-3 text-right tabular-nums">{a.avgHr ?? "—"}</td>
                        <td className="pr-3 text-right tabular-nums">{a.cadence ?? "—"}</td>
                        <td className="pr-3 text-right tabular-nums">{a.ascentFt != null ? `${a.ascentFt} ft` : "—"}</td>
                        <td className="text-right tabular-nums">{a.trainingEffect ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>

            <Panel key="day-detail" title="Day detail" icon="🔍" sub="Heart rate and stress through the day, in 5-minute steps">
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <select value={pick ?? ""} onChange={e => setPick(e.target.value)} className="rounded-lg bg-slate-800 border border-white/10 text-xs px-2 py-1 text-slate-200">
                  {[...dates].reverse().map(d => <option key={d} value={d}>{dayLabel(d)} {shortDate(d)}</option>)}
                </select>
                {detail?.activities.map(a => (
                  <span key={a.id} className="text-[11px] rounded-full border border-white/10 bg-slate-800/60 px-2 py-0.5 text-slate-300">
                    {/running/i.test(a.sport) ? "🏃" : "🚶"} {a.startTime.slice(11, 16)} · {fix(a.distanceMi, 2)} mi · {pace(a.paceSec)}/mi
                  </span>
                ))}
              </div>
              {detail && detail.points.length > 0 ? (
                <ResponsiveContainer width="100%" height={260}>
                  <ComposedChart data={detail.points} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                    <XAxis dataKey="t" tick={tick} axisLine={{ stroke: C.grid }} tickLine={false} interval={35} />
                    <YAxis yAxisId="hr" domain={["dataMin - 5", "dataMax + 5"]} tick={{ ...tick, fill: C.rhr }} axisLine={false} tickLine={false} width={30} allowDecimals={false} />
                    <YAxis yAxisId="st" orientation="right" domain={[0, 100]} tick={{ ...tick, fill: C.stress }} axisLine={false} tickLine={false} width={28} />
                    <Tooltip {...tip} />
                    <Legend wrapperStyle={{ fontSize: 11, color: C.axis }} />
                    <Area yAxisId="st" dataKey="stress" name="Stress" stroke={C.stress} fill={C.stress} fillOpacity={0.12} dot={false} connectNulls isAnimationActive={false} />
                    <Line yAxisId="hr" dataKey="hr" name="Heart rate (bpm)" stroke={C.rhr} strokeWidth={1.8} dot={false} connectNulls isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              ) : <p className="text-sm text-slate-500">{detail ? "No heart-rate data for this day." : "Loading…"}</p>}
            </Panel>
            </Sortable>

            <p className="text-[11px] text-slate-600">
              Heart rate, stress, steps, activities and weight from GarminDB; HRV and sleep as on the Health page; food from the Lose It! diary.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
