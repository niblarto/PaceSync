"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bar, CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis,
} from "recharts";
import { formatWeight, formatWeightDelta, LB_PER_KG, type WeightUnit } from "@/lib/weight-format";

// Mirrors lib/nutrition-dashboard.ts
interface DayRow {
  date: string;
  eaten: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  burnt: number | null;
  resting: number | null;
  exercise: number | null;
  weightKg: number | null;
  deficit: number | null;
}
interface Summary { id: number; createdAt: string; periodStart: string; periodEnd: string; content: string; model: string | null }
interface SummaryState {
  summary: Summary | null;
  due: boolean;
  nextAt: string;
  writing: boolean;
  error: string | null;
  result?: { status: "fresh" | "writing" | "unavailable"; reason?: string };
}
interface Projection {
  method: "trend" | "energy" | "plan";
  label: string;
  basis: string;
  kgPerWeek: number;
  weightAtGoalKg: number | null;
  hitDate: string | null;
  hitStatus: "reached" | "on-course" | "never";
}
interface Dashboard {
  config: {
    targetWeightKg: number | null;
    goalDate: string | null;
    dailyCalorieLimit: number | null;
    weightUnit: WeightUnit;
    trendDays: number;
    kcalPerKg: number;
  };
  today: string;
  days: DayRow[];
  weights: { date: string; kg: number }[];
  current: { kg: number; date: string; avg7Kg: number } | null;
  averages: {
    eaten: number | null; burnt: number | null; exercise: number | null; deficit: number | null;
    loggedDays: number; windowDays: number; deficit7: number | null; deficit7Days: number;
  };
  projections: Projection[];
  required: { kgPerWeek: number; dailyBalance: number; intake: number | null } | null;
}

const RANGES = [14, 30, 90] as const;
const DAY_MS = 86_400_000;
const PROJ_COLORS: Record<Projection["method"], string> = { trend: "#a78bfa", energy: "#f59e0b", plan: "#38bdf8" };

const C = {
  eaten: "#f59e0b",
  burnt: "#38bdf8",
  exercise: "#34d399",
  limit: "#f87171",
  deficit: "#e879f9",
  weight: "#e2e8f0",
  target: "#34d399",
  axis: "#64748b",
  grid: "rgba(255,255,255,0.05)",
};

const toMs = (date: string) => new Date(`${date}T12:00:00`).getTime();
const msToYmd = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const shortDate = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const longDate = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const daysUntil = (from: string, to: string) => Math.round((toMs(to) - toMs(from)) / DAY_MS);
const kcal = (n: number | null | undefined) => (n == null ? "—" : `${Math.round(n).toLocaleString("en-GB")}`);

function Card({ title, children, className = "" }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5 ${className}`}>
      {title && <h2 className="text-sm font-semibold text-slate-300 mb-3">{title}</h2>}
      {children}
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-4 min-w-0">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-2xl font-semibold text-slate-100 mt-1 tabular-nums truncate">{value}</div>
      {sub && <div className="text-xs text-slate-400 mt-1">{sub}</div>}
    </div>
  );
}

function CaloriesTooltip({ active, payload, label }: { active?: boolean; payload?: { payload: DayRow }[]; label?: string }) {
  if (!active || !payload?.length || !label) return null;
  const d = payload[0].payload;
  const def = d.deficit;
  return (
    <div className="rounded-lg bg-slate-950/95 border border-white/10 px-3 py-2 text-xs space-y-0.5 shadow-lg">
      <div className="font-medium text-slate-200 mb-1">{longDate(label)}</div>
      <div style={{ color: C.eaten }}>Eaten: {kcal(d.eaten)} kcal</div>
      <div style={{ color: C.burnt }}>Burnt: {kcal(d.burnt)} kcal{d.resting != null ? ` (${kcal(d.resting)} resting)` : ""}</div>
      <div style={{ color: C.exercise }}>Exercise: {kcal(d.exercise)} kcal</div>
      {def != null && (
        <div className={def >= 0 ? "text-emerald-300" : "text-rose-300"}>
          {def >= 0 ? "Deficit" : "Surplus"} (burnt − eaten): {kcal(Math.abs(def))} kcal
        </div>
      )}
      {d.proteinG != null && (
        <div className="text-slate-400 pt-1">P {Math.round(d.proteinG)} g · C {Math.round(d.carbsG ?? 0)} g · F {Math.round(d.fatG ?? 0)} g</div>
      )}
    </div>
  );
}

// Minimal Markdown for the AI summary: **bold**, headings, bullet lists.
function inlineMd(text: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**")
      ? <strong key={i} className="text-slate-100 font-semibold">{part.slice(2, -2)}</strong>
      : <span key={i}>{part}</span>);
}

function SummaryMarkdown({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) {
      blocks.push(<ul key={blocks.length} className="list-disc pl-5 space-y-1">{list.map((l, i) => <li key={i}>{inlineMd(l)}</li>)}</ul>);
      list = [];
    }
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const bullet = line.match(/^[-*•]\s+(.*)$/) ?? line.match(/^\d+[.)]\s+(.*)$/);
    if (bullet) { list.push(bullet[1]); continue; }
    flush();
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    if (heading) blocks.push(<h3 key={blocks.length} className="text-slate-100 font-semibold pt-1">{inlineMd(heading[1])}</h3>);
    else blocks.push(<p key={blocks.length}>{inlineMd(line)}</p>);
  }
  flush();
  return <div className="space-y-2 text-sm text-slate-300 leading-relaxed">{blocks}</div>;
}

const whenLabel = (iso: string) => new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

// Daily AI summary of the last 14 days. A new one is due from 05:00 each
// day; while one is due this asks the server every minute, which writes it
// as soon as the AI DJ service answers.
function SummaryPanel() {
  const [s, setS] = useState<SummaryState | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const poll = useCallback(async (method: "GET" | "POST") => {
    try {
      const res = await fetch("/api/nutrition/summary", { method });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `Failed (${res.status})`);
      setS(d);
      setFailed(null);
      return d as SummaryState;
    } catch (e) {
      setFailed(e instanceof Error ? e.message : "Failed");
      return null;
    }
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const tick = async (first: boolean) => {
      const d = await poll(first ? "GET" : "POST");
      if (stopped) return;
      if (d && first && d.due && !d.writing) {
        // Due: try straight away rather than waiting a minute.
        tick(false);
        return;
      }
      if (d && !d.due && !d.writing) return; // up to date until 05:00 tomorrow
      // Writing: check back soon. Waiting for the service: every minute.
      timer = setTimeout(() => tick(false), d?.writing ? 10_000 : 60_000);
    };
    tick(true);
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [poll]);

  const waiting = s?.due && !s.writing;
  return (
    <Card>
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-sm font-semibold text-slate-300">🧠 AI summary · last 14 days</h2>
        {s?.summary && (
          <span className="text-[11px] text-slate-500 text-right">
            {whenLabel(s.summary.createdAt)}{s.summary.model ? ` · ${s.summary.model}` : ""}
          </span>
        )}
      </div>
      {s?.writing && <p className="text-xs text-emerald-300 mb-3 animate-pulse">Writing today&apos;s summary…</p>}
      {waiting && (
        <p className="text-xs text-amber-300 mb-3">
          Today&apos;s summary is due. {s.result?.status === "unavailable" ? `${s.result.reason}; ` : ""}checking again every minute.
        </p>
      )}
      {s?.error && !s.writing && <p className="text-xs text-rose-300 mb-3">Last attempt failed: {s.error}</p>}
      {failed && <p className="text-xs text-rose-300 mb-3">{failed}</p>}
      {!s ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : s.summary ? (
        <>
          <SummaryMarkdown text={s.summary.content} />
          {!s.due && <p className="text-[11px] text-slate-500 mt-3">Next summary from {whenLabel(s.nextAt)}.</p>}
        </>
      ) : (
        <p className="text-sm text-slate-500">No summary yet.</p>
      )}
    </Card>
  );
}

export function NutritionClient() {
  const [range, setRange] = useState<(typeof RANGES)[number]>(30);
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (days: number) => {
    setError(null);
    try {
      const res = await fetch(`/api/nutrition/dashboard?days=${days}`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `Failed (${res.status})`);
      setData(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, []);

  useEffect(() => { load(range); }, [range, load]);

  const unit = data?.config.weightUnit ?? "st";
  const cfg = data?.config;
  const today = data?.today;
  const todayRow = data?.days.find(d => d.date === today);

  // Weight chart: history + a straight projection line per method from the
  // current 7-day average out to the later of the goal date / hit date.
  const weightChart = useMemo(() => {
    if (!data || !data.current || !today) return null;
    const startMs = toMs(today) - 90 * DAY_MS;
    const history = data.weights.filter(w => toMs(w.date) >= startMs).map(w => ({ t: toMs(w.date), kg: w.kg }));
    const anchor = data.current.avg7Kg;
    const candidates = [toMs(today) + 60 * DAY_MS];
    if (cfg?.goalDate) candidates.push(toMs(cfg.goalDate));
    for (const p of data.projections) if (p.hitDate) candidates.push(toMs(p.hitDate));
    const endMs = Math.min(Math.max(...candidates), toMs(today) + 730 * DAY_MS);
    const lines = data.projections.map(p => {
      const days = (endMs - toMs(today)) / DAY_MS;
      return {
        p,
        points: [
          { t: toMs(today), kg: anchor },
          { t: endMs, kg: anchor + (p.kgPerWeek / 7) * days },
        ],
      };
    });
    const ys = [...history.map(h => h.kg), ...lines.flatMap(l => l.points.map(x => x.kg))];
    if (cfg?.targetWeightKg != null) ys.push(cfg.targetWeightKg);
    const lo = Math.min(...ys), hi = Math.max(...ys);
    const pad = Math.max(0.5, (hi - lo) * 0.08);
    return { history, lines, startMs: history[0]?.t ?? startMs, endMs, domain: [lo - pad, hi + pad] as [number, number] };
  }, [data, cfg, today]);

  const weightTick = (kg: number) => {
    if (unit === "kg") return `${kg.toFixed(0)}`;
    const lb = kg * LB_PER_KG;
    if (unit === "lb") return `${lb.toFixed(0)}`;
    const st = Math.floor(lb / 14);
    return `${st}st ${Math.round(lb - st * 14)}`;
  };

  return (
    <div className="relative isolate min-h-screen flex flex-col text-slate-100">
      <div aria-hidden className="fixed inset-0 -z-10 bg-slate-950 bg-cover bg-center bg-no-repeat pointer-events-none"
        style={{ backgroundImage: "linear-gradient(rgba(2,6,23,0.85), rgba(2,6,23,0.85)), url('/dashboard-hero.png')" }} />
      <header className="border-b border-white/5 bg-slate-950/70 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-[100rem] mx-auto px-4 h-14 flex items-center justify-between gap-3">
          <Link href="/dashboard" className="text-sm text-slate-500 hover:text-slate-300 transition-colors">← Dashboard</Link>
          <span className="font-bold text-green-400 text-lg tracking-tight">🥗 Nutrition</span>
          <Link href="/settings?tab=nutrition" className="text-xs text-slate-500 hover:text-slate-300 transition-colors">Goals</Link>
        </div>
      </header>

      <main className="flex-1 max-w-[100rem] w-full mx-auto px-4 py-6 space-y-6">
        {error && <Card><p className="text-sm text-rose-300">{error}</p></Card>}
        {!data && !error && <p className="text-sm text-slate-500">Loading…</p>}

        {data && cfg && today && (
          <>
            {(cfg.targetWeightKg == null || !cfg.goalDate || cfg.dailyCalorieLimit == null) && (
              <Card>
                <p className="text-sm text-slate-300">
                  Set your target weight, goal date and daily calorie limit in{" "}
                  <Link href="/settings?tab=nutrition" className="text-emerald-300 hover:text-emerald-200">Settings → Nutrition</Link>{" "}
                  to see projections.
                </p>
              </Card>
            )}

            {/* Headline numbers */}
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
              <Stat
                label="Current weight"
                value={formatWeight(data.current?.kg, unit)}
                sub={data.current ? <>{shortDate(data.current.date)} · 7-day avg {formatWeight(data.current.avg7Kg, unit)}</> : "No weigh-ins yet"}
              />
              <Stat
                label="Target weight"
                value={formatWeight(cfg.targetWeightKg, unit)}
                sub={cfg.targetWeightKg != null && data.current
                  ? `${formatWeightDelta(data.current.avg7Kg - cfg.targetWeightKg, unit).replace(/^[+−]/, "")} to go`
                  : "Not set"}
              />
              <Stat
                label="Goal date"
                value={cfg.goalDate ? longDate(cfg.goalDate) : "—"}
                sub={cfg.goalDate
                  ? <>
                      {daysUntil(today, cfg.goalDate)} days left
                      {data.required && <> · needs {formatWeightDelta(data.required.kgPerWeek, unit)}/wk</>}
                    </>
                  : "Not set"}
              />
              <Stat
                label="Eaten today"
                value={`${kcal(todayRow?.eaten ?? 0)} kcal`}
                sub={cfg.dailyCalorieLimit != null
                  ? (() => {
                      const left = cfg.dailyCalorieLimit - (todayRow?.eaten ?? 0);
                      return left >= 0
                        ? <span className="text-emerald-300">{kcal(left)} left of {kcal(cfg.dailyCalorieLimit)}</span>
                        : <span className="text-rose-300">{kcal(-left)} over {kcal(cfg.dailyCalorieLimit)}</span>;
                    })()
                  : "No limit set"}
              />
              {(() => {
                const avg = data.averages.deficit7;
                const lastFull = [...data.days].reverse().find(d => d.date < today && d.deficit != null);
                return (
                  <Stat
                    label="Avg deficit (last 7 days)"
                    value={avg == null ? "—" : `${kcal(Math.abs(avg))} kcal`}
                    sub={avg == null
                      ? "Needs logged days with Garmin burn"
                      : <>
                          <span className={avg >= 0 ? "text-emerald-300" : "text-rose-300"}>{avg >= 0 ? "deficit" : "surplus"}/day</span>
                          {" "}over {data.averages.deficit7Days} logged day{data.averages.deficit7Days === 1 ? "" : "s"}
                          {lastFull && <> · {shortDate(lastFull.date)}: {lastFull.deficit! >= 0 ? "−" : "+"}{kcal(Math.abs(lastFull.deficit!))}</>}
                        </>}
                  />
                );
              })()}
            </div>

            <SummaryPanel />

            {/* Calories chart */}
            <Card>
              <div className="flex items-center justify-between gap-3 mb-3">
                <h2 className="text-sm font-semibold text-slate-300">Daily calories</h2>
                <div className="flex gap-1">
                  {RANGES.map(r => (
                    <button key={r} onClick={() => setRange(r)}
                      className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${
                        range === r ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-300" : "border-white/10 text-slate-400 hover:text-slate-200"
                      }`}>
                      {r}d
                    </button>
                  ))}
                </div>
              </div>
              <ResponsiveContainer width="100%" height={320}>
                <ComposedChart data={data.days} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={1} barCategoryGap="20%">
                  <CartesianGrid strokeDasharray="3 3" stroke={C.grid} vertical={false} />
                  <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fill: C.axis, fontSize: 10 }} axisLine={{ stroke: C.grid }} tickLine={false} minTickGap={16} />
                  <YAxis tick={{ fill: C.axis, fontSize: 10 }} axisLine={false} tickLine={false} width={44} />
                  <Tooltip content={<CaloriesTooltip />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
                  <Legend wrapperStyle={{ fontSize: 11, color: C.axis }} />
                  <Bar dataKey="eaten" name="Eaten" fill={C.eaten} radius={[2, 2, 0, 0]} />
                  <Bar dataKey="burnt" name="Burnt" fill={C.burnt} radius={[2, 2, 0, 0]} />
                  <Bar dataKey="exercise" name="Exercise" fill={C.exercise} radius={[2, 2, 0, 0]} />
                  <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" />
                  <Line dataKey="deficit" name="Deficit (burnt − eaten)" stroke={C.deficit} strokeWidth={2}
                    dot={{ r: 2.5, fill: C.deficit }} connectNulls={false} isAnimationActive={false} />
                  {cfg.dailyCalorieLimit != null && (
                    <ReferenceLine y={cfg.dailyCalorieLimit} stroke={C.limit} strokeDasharray="6 4"
                      label={{ value: `Limit ${kcal(cfg.dailyCalorieLimit)}`, fill: C.limit, fontSize: 10, position: "insideTopRight" }} />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
              <p className="text-xs text-slate-500 mt-2">
                Last {data.averages.windowDays} days (not counting today): avg eaten {kcal(data.averages.eaten)} kcal on{" "}
                {data.averages.loggedDays} logged days · avg burnt {kcal(data.averages.burnt)} · avg exercise {kcal(data.averages.exercise)} ·
                avg deficit {data.averages.deficit == null ? "—" : `${kcal(data.averages.deficit)} kcal`}.
                Days with nothing logged in Lose It! are left out of the eaten average.
              </p>
            </Card>

            <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-6 items-start">
              {/* Weight + projections chart */}
              <Card title="Weight and projections">
                {!weightChart ? (
                  <p className="text-sm text-slate-500">No weigh-ins yet.</p>
                ) : (
                  <ResponsiveContainer width="100%" height={320}>
                    <ComposedChart margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                      <XAxis dataKey="t" type="number" scale="time" domain={[weightChart.startMs, weightChart.endMs]}
                        tickFormatter={t => shortDate(msToYmd(t))} tick={{ fill: C.axis, fontSize: 10 }}
                        axisLine={{ stroke: C.grid }} tickLine={false} minTickGap={24} />
                      <YAxis dataKey="kg" type="number" domain={weightChart.domain} tickFormatter={weightTick}
                        tick={{ fill: C.axis, fontSize: 10 }} axisLine={false} tickLine={false} width={unit === "st" ? 58 : 40} />
                      <Tooltip
                        contentStyle={{ background: "rgba(2,6,23,0.95)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12 }}
                        labelFormatter={t => longDate(msToYmd(Number(t)))}
                        formatter={(v: number, name: string) => [formatWeight(v, unit), name]}
                      />
                      <Legend wrapperStyle={{ fontSize: 11, color: C.axis }} />
                      {cfg.targetWeightKg != null && (
                        <ReferenceLine y={cfg.targetWeightKg} stroke={C.target} strokeDasharray="6 4"
                          label={{ value: "Target", fill: C.target, fontSize: 10, position: "insideBottomLeft" }} />
                      )}
                      {cfg.goalDate && (
                        <ReferenceLine x={toMs(cfg.goalDate)} stroke={C.target} strokeDasharray="2 4"
                          label={{ value: "Goal date", fill: C.target, fontSize: 10, position: "insideTopLeft" }} />
                      )}
                      <ReferenceLine x={toMs(today)} stroke="rgba(255,255,255,0.2)" />
                      <Scatter data={weightChart.history} dataKey="kg" name="Weigh-ins" fill={C.weight} shape="circle" r={2} />
                      {weightChart.lines.map(l => (
                        <Line key={l.p.method} data={l.points} dataKey="kg" name={l.p.label} stroke={PROJ_COLORS[l.p.method]}
                          strokeWidth={2} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
                      ))}
                    </ComposedChart>
                  </ResponsiveContainer>
                )}
              </Card>

              {/* Projection table */}
              <Card title="Projections">
                {data.projections.length === 0 ? (
                  <p className="text-sm text-slate-500">Not enough data yet. Projections need a few weigh-ins or logged days.</p>
                ) : (
                  <div className="space-y-3">
                    {data.projections.map(p => (
                      <div key={p.method} className="rounded-lg border border-white/10 bg-slate-800/40 p-3">
                        <div className="flex items-center gap-2">
                          <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: PROJ_COLORS[p.method] }} />
                          <span className="text-sm font-medium text-slate-200">{p.label}</span>
                          <span className="ml-auto text-xs text-slate-400 tabular-nums">{formatWeightDelta(p.kgPerWeek, unit)}/wk</span>
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5">{p.basis}</div>
                        <div className="grid grid-cols-2 gap-3 mt-2 text-sm">
                          <div>
                            <div className="text-xs text-slate-500">
                              Projected weight on target date{cfg.goalDate ? ` (${shortDate(cfg.goalDate)})` : ""}
                            </div>
                            <div className="tabular-nums text-slate-100">{formatWeight(p.weightAtGoalKg, unit)}</div>
                            {p.weightAtGoalKg != null && cfg.targetWeightKg != null && (() => {
                              const diff = p.weightAtGoalKg - cfg.targetWeightKg;
                              const amount = formatWeightDelta(Math.abs(diff), unit).replace(/^\+/, "");
                              return (
                                <div className={`text-xs ${diff <= 0.05 ? "text-emerald-300" : "text-amber-300"}`}>
                                  {Math.abs(diff) < 0.05 ? "On target" : `${amount} ${diff > 0 ? "above" : "below"} target`}
                                </div>
                              );
                            })()}
                          </div>
                          <div>
                            <div className="text-xs text-slate-500">Target reached</div>
                            <div className={`tabular-nums ${
                              p.hitStatus === "never" ? "text-rose-300"
                                : p.hitDate && cfg.goalDate && p.hitDate <= cfg.goalDate ? "text-emerald-300" : "text-amber-300"
                            }`}>
                              {cfg.targetWeightKg == null ? "—"
                                : p.hitStatus === "reached" ? "Already there"
                                : p.hitStatus === "never" ? "Not at this rate"
                                : longDate(p.hitDate!)}
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                    {data.required && (
                      <p className="text-xs text-slate-400 border-t border-white/10 pt-3">
                        To reach your target by {longDate(cfg.goalDate!)} you need {formatWeightDelta(data.required.kgPerWeek, unit)}/wk,
                        a daily {data.required.dailyBalance <= 0 ? "deficit" : "surplus"} of {kcal(Math.abs(data.required.dailyBalance))} kcal
                        {data.required.intake != null && <> (about {kcal(data.required.intake)} kcal eaten/day at your average burn)</>}.
                      </p>
                    )}
                    <p className="text-[11px] text-slate-500">
                      Based on the last {cfg.trendDays} days, starting from your 7-day average weight. Calorie projections assume{" "}
                      {kcal(cfg.kcalPerKg)} kcal per kg and are only as good as your logging.
                    </p>
                  </div>
                )}
              </Card>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
