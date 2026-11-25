"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatWeight, LB_PER_KG } from "@/lib/weight-format";
import { Sortable } from "@/components/Sortable";
import { Area, CartesianGrid, ComposedChart, Line, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

// The Metrics page's Grafana-style "Today" board (midnight until now): gauges down the left (resting HR, steps, SpO2, sleep) and wide
// time-series panels beside them (stress + Body Battery, cumulative steps with colour bands, hourly steps, heart rate,
// breathing, SpO2), each with a Min / Max / Mean legend table. Data from /api/metrics/live.
interface Pt { t: number; v: number }
interface Live {
  date: string; now: number; hr: Pt[]; stress: Pt[]; bodyBattery: Pt[]; rr: Pt[]; spo2: Pt[]; stepsCum: Pt[]; stepsHourly: Pt[];
  gauges: { rhr: number | null; steps: number | null; spo2: number | null; sleepHours: number | null; stepGoal: number | null };
  trainingStatus: {
    label: string | null; acute: number | null; chronic: number | null; ratio: number | null; acwrStatus: string | null; tunnelMin: number | null; tunnelMax: number | null; vo2Max: number | null;
    balance: { aerobicLow: number; aerobicHigh: number; anaerobic: number; lowMin: number; lowMax: number; highMin: number; highMax: number; anMin: number; anMax: number; feedback: string | null } | null;
  } | null;
  hillScore: { overall: number | null; strength: number | null; endurance: number | null; history: { t: number; overall: number; strength: number | null; endurance: number | null }[] } | null;
  lactate: { hr: number | null; speedMs: number | null; date: string | null; history: { t: number; hr: number | null; speedMs: number | null }[] } | null;
  enduranceScore: { score: number | null; label: string | null; bands: { name: string; from: number }[]; gaugeLower: number | null; gaugeUpper: number | null; history: { t: number; v: number }[] } | null;
  racePredictions: { latest: { s5k: number; s10k: number; half: number; full: number; date: string } | null; history: { t: number; s5k: number; s10k: number; half: number; full: number }[] } | null;
  sleepStages: { start: number; end: number; stages: { start: number; end: number; stage: "deep" | "light" | "rem" | "awake" }[] } | null;
  weight: { kg: number; date: string; avg7Kg: number; postRun: boolean; targetKg: number | null; measuredAt: string | null } | null;
  notes: string[];
}
const REFRESH_MS = 5 * 60_000;
const shortClock = (t: number) => { const d = new Date(t); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`; }; // 8:04
// The label of the day on show ("Today", or e.g. "Thu 19 Nov"), for the panel badges.
const DayLabelCtx = createContext("Today");
const addDay = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + n); return localDate(d); };
const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const GREEN = "#34d399", BLUE = "#38bdf8", AMBER = "#fbbf24", RED = "#f43f5e", ORANGE = "#f97316", PURPLE = "#a78bfa";
const tick = { fill: "#64748b", fontSize: 10 };
const tip = { contentStyle: { background: "rgba(2,6,23,0.95)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12 }, labelStyle: { color: "#e2e8f0" } };
const clock = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

// ── Gauge ──────────────────────────────────────────────────────────────────
interface Band { to: number; color: string }
function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}
function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const [x0, y0] = polar(cx, cy, r, a0), [x1, y1] = polar(cx, cy, r, a1);
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

function Gauge({ title, value, display, unit, min, max, bands }: {
  title: string; value: number | null; display: string; unit: string; min: number; max: number; bands: Band[];
}) {
  const START = 135, SWEEP = 270;
  const frac = (v: number) => Math.min(1, Math.max(0, (v - min) / (max - min)));
  const ang = (v: number) => START + SWEEP * frac(v);
  const color = value == null ? "#475569" : (bands.find(b => value <= b.to) ?? bands[bands.length - 1]).color;
  let from = min;
  return (
    <div className="rounded-xl bg-slate-900/85 border border-white/10 px-3 pt-3 pb-2">
      <p className="text-[11px] font-medium text-slate-400">{title}</p>
      <svg viewBox="0 0 160 130" className="w-full">
        <path d={arc(80, 74, 56, START, START + SWEEP)} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="11" strokeLinecap="round" />
        {value != null && value > min && <path d={arc(80, 74, 56, START, Math.max(START + 1, ang(value)))} fill="none" stroke={color} strokeWidth="11" strokeLinecap="round" />}
        {/* threshold ring */}
        {bands.map((b, i) => {
          const a0 = ang(from), a1 = ang(Math.min(b.to, max));
          from = Math.min(b.to, max);
          return a1 > a0 ? <path key={i} d={arc(80, 74, 67, a0, a1)} fill="none" stroke={b.color} strokeWidth="3" /> : null;
        })}
        <text x="80" y="80" textAnchor="middle" fontSize="26" fontWeight="600" fill={color}>{display}</text>
        <text x="80" y="118" textAnchor="middle" fontSize="11" fill="#94a3b8">{unit}</text>
      </svg>
    </div>
  );
}

const hms = (sec: number | null | undefined) => {
  if (sec == null) return "—";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = Math.round(sec % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
};

// A value on a bar with a shaded target range: used for the training load and load balance.
function RangeBar({ label, value, lo, hi, max, color }: { label: string; value: number; lo: number; hi: number; max: number; color: string }) {
  const pct = (v: number) => `${Math.min(100, Math.max(0, (v / max) * 100))}%`;
  return (
    <div>
      <div className="flex justify-between text-[11px] text-slate-400 mb-0.5"><span>{label}</span><span className="tabular-nums text-slate-300">{Math.round(value)}{hi > 0 ? <span className="text-slate-500"> · target {Math.round(lo)}–{Math.round(hi)}</span> : null}</span></div>
      <div className="relative h-2.5 rounded bg-slate-800 overflow-hidden">
        {hi > 0 && <div className="absolute top-0 bottom-0 bg-emerald-500/25" style={{ left: pct(lo), width: `${Math.max(0, ((Math.min(hi, max) - lo) / max) * 100)}%` }} />}
        <div className="absolute top-0 bottom-0 left-0 rounded" style={{ width: pct(value), background: color, opacity: 0.85 }} />
      </div>
    </div>
  );
}

// ── Panels ─────────────────────────────────────────────────────────────────
function Panel({ title, children, legend }: { title: string; children: ReactNode; legend?: { name: string; color: string; pts: Pt[]; digits?: number }[] }) {
  return (
    <section className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-100 mb-2">
        {title}<span className="text-[11px] font-normal text-sky-400/80">⏱ {useContext(DayLabelCtx)}</span>
      </h3>
      {children}
      {legend && (
        <table className="w-full text-[11px] mt-1">
          <thead>
            <tr className="text-slate-500 border-b border-white/10">
              <th className="text-left font-medium py-1">Name</th>
              <th className="text-right font-medium w-16">Min</th><th className="text-right font-medium w-16">Max</th><th className="text-right font-medium w-16">Mean</th>
            </tr>
          </thead>
          <tbody>
            {legend.map(l => {
              const v = l.pts.map(p => p.v);
              const d = l.digits ?? 0;
              return (
                <tr key={l.name} className="text-slate-300 border-b border-white/5">
                  <td className="py-1"><span className="inline-block w-3 h-0.5 align-middle mr-2" style={{ background: l.color }} />{l.name}</td>
                  <td className="text-right tabular-nums">{v.length ? Math.min(...v).toFixed(d) : "—"}</td>
                  <td className="text-right tabular-nums">{v.length ? Math.max(...v).toFixed(d) : "—"}</td>
                  <td className="text-right tabular-nums">{v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(d) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

// Day navigator (‹ day ›, click the day for a date picker) above the board for the chosen day.
export function MetricsLive({ onRefreshed, trainingEffect, editing = false, onToggleEdit, onResetLayout, layoutVersion = 0 }: {
  onRefreshed?: () => void; trainingEffect?: ReactNode;
  editing?: boolean; onToggleEdit?: () => void; onResetLayout?: () => void; layoutVersion?: number;
} = {}) {
  const today = localDate(new Date());
  const [day, setDay] = useState(today);
  const dateRef = useRef<HTMLInputElement>(null);
  const [nonce, setNonce] = useState(0);            // bumped by the refresh button: reload with the cache bypassed
  const [refreshing, setRefreshing] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const [dataUpTo, setDataUpTo] = useState<number | null>(null); // newest Garmin reading on the board
  // What the refresh is doing right now, shown under the navigator (steps, then the GarminDB sync's own progress).
  const [status, setStatus] = useState<{ lines: string[]; percent: number | null; error?: boolean } | null>(null);

  // 1. Garmin Connect: latest weigh-ins, and today's board straight from the API.
  // 2. GarminDB sync on the Pi (the same job as the 06:00 one): downloads and imports whatever Garmin Connect has,
  //    watched through its log until it finishes; then the trends are re-read from the local data.
  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    const done: string[] = [];
    const show = (now: string, percent: number | null = null, error = false) => setStatus({ lines: [...done, now], percent, error });
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    try {
      show("Garmin Connect: fetching weigh-ins and today's readings…");
      let weights = "refreshed";
      try {
        const r = await fetch("/api/metrics/refresh", { method: "POST" });
        const b = await r.json().catch(() => ({}));
        if (!r.ok) weights = `failed (${r.status})`; else if (typeof b.weights === "string") weights = b.weights;
      } catch { weights = "failed (network)"; }
      setNonce(n => n + 1); onRefreshed?.();
      done.push(`✓ Garmin Connect: today's readings reloaded; weigh-ins ${weights}`);

      show("GarminDB: starting a sync on the Pi…");
      let started = false, alreadyRunning = false;
      try {
        const r = await fetch("/api/settings/garmin/sync-status", { method: "POST" });
        if (r.ok) started = true; else if (r.status === 409) alreadyRunning = true;
        else { done.push(`✗ GarminDB sync couldn't start (${r.status})`); }
      } catch { done.push("✗ GarminDB sync couldn't start (network)"); }

      if (started || alreadyRunning) {
        if (alreadyRunning) done.push("• A GarminDB sync was already running; following it");
        let seen = false;
        const t0 = Date.now();
        for (;;) {
          await sleep(3000);
          let st: { running?: boolean; progress?: { percent: number; current: number; total: number; eta: string; section: string } | null; logTail?: string[] } | null = null;
          try { st = await (await fetch("/api/settings/garmin/sync-status")).json(); } catch { /* try again */ }
          if (st?.running) {
            seen = true;
            const p = st.progress;
            const last = st.logTail?.[st.logTail.length - 1] ?? "";
            show(p ? `GarminDB sync: ${p.section || "working"} ${p.percent}% (${p.current}/${p.total}, ${p.eta} left)` : `GarminDB sync: ${last || "working…"}`, p?.percent ?? null);
          } else if (st && (seen || Date.now() - t0 > 20_000)) {
            done.push(seen ? "✓ GarminDB sync finished" : "• GarminDB sync had nothing to do");
            break;
          } else {
            show("GarminDB: waiting for the sync to start…");
          }
          if (Date.now() - t0 > 20 * 60_000) { done.push("✗ GarminDB sync is taking over 20 minutes; leaving it to finish in the background"); break; }
        }
        show("Reloading the trends from the updated local data…");
        setNonce(n => n + 1); onRefreshed?.();
        await sleep(1500);
      }
      setRefreshedAt(Date.now());
      setStatus({ lines: [...done, `Done at ${clock(Date.now())}`], percent: null });
      setTimeout(() => setStatus(null), 20_000);
    } catch (e) {
      setStatus({ lines: [...done, `Refresh failed: ${e instanceof Error ? e.message : "error"}`], percent: null, error: true });
    } finally {
      setRefreshing(false);
    }
  }
  const isToday = day === today;
  const label = isToday ? "Today" : new Date(`${day}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const btn = "h-7 w-7 rounded-lg border border-white/10 bg-slate-800/60 text-slate-300 hover:text-white hover:bg-slate-700/60 disabled:opacity-30 disabled:hover:bg-slate-800/60 transition-colors";
  return (
    <DayLabelCtx.Provider value={label}>
      <div className="flex items-center gap-2 mb-3">
        <button className={btn} onClick={() => setDay(d => addDay(d, -1))} aria-label="Previous day" title="Previous day">‹</button>
        <button type="button" className="relative cursor-pointer rounded-lg border border-white/10 bg-slate-800/60 px-3 py-1 text-sm font-semibold text-slate-100 hover:bg-slate-700/60 transition-colors" title="Pick a date"
          onClick={() => { const el = dateRef.current; if (!el) return; try { el.showPicker(); } catch { el.focus(); el.click(); } }}>
          📅 {label}
          {/* the native date input sits under the button (invisible); the click above opens its picker, anchored here */}
          <input ref={dateRef} type="date" value={day} max={today} tabIndex={-1} aria-label="Pick a date"
            onChange={e => e.target.value && setDay(e.target.value > today ? today : e.target.value)}
            className="absolute inset-0 w-full h-full opacity-0 pointer-events-none" />
        </button>
        {isToday ? (
          <button className={btn} onClick={refresh} disabled={refreshing} aria-label="Refresh" title="Refresh: pull today from Garmin Connect, then run a GarminDB sync and reload the trends">
            <span className={refreshing ? "inline-block animate-spin" : "inline-block"}>⟳</span>
          </button>
        ) : (
          <button className={btn} onClick={() => setDay(d => (addDay(d, 1) > today ? today : addDay(d, 1)))} aria-label="Next day" title="Next day">›</button>
        )}
        {isToday && refreshedAt && <span className="text-[11px] text-slate-500 ml-1">Synced {shortClock(refreshedAt)}{dataUpTo ? ` - Garmin data up to ${shortClock(dataUpTo)}` : ""}</span>}
        {!isToday && <button className="text-xs text-sky-300 hover:text-sky-200 underline ml-1" onClick={() => setDay(today)}>Back to today</button>}
        {/* top right: rearrange the boxes of each section */}
        <div className="ml-auto flex items-center gap-2">
          {editing && onResetLayout && <button className="text-xs text-slate-400 hover:text-slate-200 underline" onClick={onResetLayout} title="Put every box back in its original place">Reset layout</button>}
          {onToggleEdit && (
            <button className={`${btn} ${editing ? "!bg-sky-500/25 !border-sky-400/60 !text-sky-100" : ""}`} onClick={onToggleEdit} aria-pressed={editing}
              title={editing ? "Done rearranging" : "Rearrange the boxes in each section"}>
              {editing ? "✓" : "✏️"}
            </button>
          )}
        </div>
      </div>
      {status && (
        <div className={`mb-3 rounded-lg border px-3 py-2 text-xs space-y-0.5 ${status.error ? "border-rose-500/30 bg-rose-500/10 text-rose-200" : "border-white/10 bg-slate-900/70 text-slate-300"}`}>
          {status.lines.map((l, i) => (
            <p key={i} className={i === status.lines.length - 1 && refreshing ? "text-sky-300" : l.startsWith("✗") ? "text-amber-300" : ""}>
              {i === status.lines.length - 1 && refreshing && <span className="inline-block animate-spin mr-1.5">⟳</span>}{l}
            </p>
          ))}
          {status.percent != null && (
            <div className="h-1 rounded bg-slate-800 overflow-hidden mt-1"><div className="h-full bg-sky-400 transition-all" style={{ width: `${status.percent}%` }} /></div>
          )}
        </div>
      )}
      <LiveBoard key={day} day={day} isToday={isToday} nonce={nonce} onDataUpTo={setDataUpTo} trainingEffect={trainingEffect} editing={editing} layoutVersion={layoutVersion} />
    </DayLabelCtx.Provider>
  );
}

function LiveBoard({ day, isToday, nonce, onDataUpTo, trainingEffect, editing, layoutVersion }: { day: string; isToday: boolean; nonce: number; onDataUpTo: (t: number | null) => void; trainingEffect?: ReactNode; editing: boolean; layoutVersion: number }) {
  const [live, setLive] = useState<Live | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Today (the browser's day), midnight until now; refreshed every few minutes.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch(`/api/metrics/live?date=${day}${nonce > 0 ? "&force=1" : ""}`).then(async r => { const b = await r.json(); if (!r.ok) throw new Error(b.error || `Failed (${r.status})`); return b as Live; })
        .then(d => {
          if (!alive) return;
          setLive(d); setNow(Date.now()); setError(null);
          // newest reading Garmin has sent (what the watch last synced)
          const last = [d.hr, d.stress, d.bodyBattery, d.rr].map(a => a[a.length - 1]?.t ?? 0);
          const t = Math.max(...last);
          onDataUpTo(t > 0 ? t : null);
        })
        .catch(e => { if (alive) setError(e instanceof Error ? e.message : "Couldn't load today's data"); });
    };
    load();
    const id = isToday ? setInterval(load, REFRESH_MS) : null; // only today keeps changing
    return () => { alive = false; if (id) clearInterval(id); };
  }, [day, isToday, nonce]);
  const midnight = useMemo(() => new Date(`${day}T00:00:00`).getTime(), [day]);
  const end = isToday ? Math.max(now, midnight + 3600_000) : midnight + 24 * 3600_000; // right edge of the charts

  // One merged series per chart so lines share an x axis.
  const stressBb = useMemo(() => {
    if (!live) return [];
    const m = new Map<number, { t: number; stress?: number; bb?: number }>();
    for (const p of live.stress) m.set(p.t, { t: p.t, stress: p.v });
    for (const p of live.bodyBattery) {
      const t = Math.round(p.t / 300_000) * 300_000;
      m.set(t, { ...(m.get(t) ?? { t }), bb: p.v });
    }
    return Array.from(m.values()).sort((a, b) => a.t - b.t);
  }, [live]);

  if (error && !live) return <p className="text-sm text-rose-300">{error}</p>;
  if (!live) return <p className="text-sm text-slate-500">Loading…</p>;

  // x axis: midnight → now, with a tick every hour (every 2-3 hours as the day fills up)
  const spanH = Math.max(1, (end - midnight) / 3600_000);
  const stepH = spanH <= 8 ? 1 : spanH <= 16 ? 2 : 3;
  const xAxis = (
    <XAxis dataKey="t" type="number" scale="time" domain={[midnight, end]} allowDataOverflow tick={tick} tickFormatter={clock}
      axisLine={{ stroke: "rgba(255,255,255,0.08)" }} tickLine={false}
      ticks={Array.from({ length: Math.floor(spanH / stepH) + 1 }, (_, i) => midnight + i * stepH * 3600_000)} />
  );
  const grid = <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />;
  const g = live.gauges;
  const goal = g.stepGoal ?? 8000;
  const maxSteps = Math.max(10_000, Math.ceil((live.stepsCum[live.stepsCum.length - 1]?.v ?? 0) / 2000) * 2000, goal);
  const hourMax = Math.max(1, ...live.stepsHourly.map(h => h.v));

  return (
    <>
    <h2 className="text-sm font-semibold text-slate-300 mb-2">Training and fitness</h2>
    <Sortable section="training" editing={editing} layoutVersion={layoutVersion} className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
      <TrainingStatusPanel key="status" ts={live.trainingStatus} />
      <RacePredictionsPanel key="race" rp={live.racePredictions} />
      {trainingEffect}
      <HillScorePanel key="hill" hs={live.hillScore} />
      <EnduranceScorePanel key="endurance" es={live.enduranceScore} />
      <LactatePanel key="lactate" lt={live.lactate} />
    </Sortable>
    <h2 className="text-sm font-semibold text-slate-300 mb-2">{isToday ? "Today" : "The day"}</h2>
    <div className="grid grid-cols-1 lg:grid-cols-[200px_minmax(0,1fr)] gap-4">
      <div className="content-start space-y-3">
      <Sortable section="today-gauges" editing={editing} layoutVersion={layoutVersion} className="grid grid-cols-2 lg:grid-cols-1 gap-3 content-start" itemClassNames={{ weight: "col-span-2 lg:col-span-1" }}>
        <Gauge key="rhr" title={isToday ? "Today RHR" : "RHR"} value={g.rhr} display={g.rhr != null ? String(g.rhr) : "—"} unit="Resting HR" min={30} max={100}
          bands={[{ to: 50, color: BLUE }, { to: 65, color: GREEN }, { to: 80, color: AMBER }, { to: 100, color: RED }]} />
        <Gauge key="steps" title={isToday ? "Today's Steps" : "Steps"} value={g.steps} display={g.steps != null ? (g.steps >= 1000 ? `${(g.steps / 1000).toFixed(2)} K` : String(g.steps)) : "—"} unit={`Steps · goal ${goal.toLocaleString("en-GB")}`}
          min={0} max={goal * 1.25} bands={[{ to: goal * 0.3, color: RED }, { to: goal * 0.6, color: ORANGE }, { to: goal, color: GREEN }, { to: goal * 1.25, color: BLUE }]} />
        <Gauge key="spo2" title={isToday ? "Today SpO2" : "SpO2"} value={g.spo2} display={g.spo2 != null ? String(g.spo2) : "—"} unit="SpO2 %" min={80} max={100}
          bands={[{ to: 90, color: RED }, { to: 94, color: AMBER }, { to: 100, color: GREEN }]} />
        <Gauge key="sleep" title="Last Sleep Hours" value={g.sleepHours} display={g.sleepHours != null ? g.sleepHours.toFixed(1) : "—"} unit="Hours" min={0} max={10}
          bands={[{ to: 5, color: RED }, { to: 6.5, color: ORANGE }, { to: 9, color: GREEN }, { to: 10, color: BLUE }]} />
        {live.weight && (() => {
          const w = live.weight, lb = w.kg * LB_PER_KG, toGo = w.targetKg != null ? lb - w.targetKg * LB_PER_KG : null;
          return (
            <div key="weight" className="rounded-xl bg-slate-900/85 border border-white/10 px-3 py-3">
              <p className="text-[11px] font-medium text-slate-400">Current Weight</p>
              <p className="text-xl font-semibold text-slate-100 tabular-nums mt-1">{formatWeight(w.kg, "st", { exact: true })}</p>
              <p className="text-[11px] text-slate-500">{lb.toFixed(1)} lb · {new Date(`${w.date}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}{w.postRun ? " (post-run)" : ""}</p>
              <p className="text-[11px] text-slate-500">7-day avg {formatWeight(w.avg7Kg, "st", { exact: true })}</p>
              {toGo != null && toGo > 0 && <p className="text-[11px] text-sky-300/80">{toGo.toFixed(1)} lb to goal</p>}
            </div>
          );
        })()}
      </Sortable>
        <p className="text-[11px] text-slate-600">
          {new Date(midnight).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}
          {isToday ? `, midnight to ${clock(now)}, live from Garmin Connect (refreshes every 5 minutes; the watch syncs to Garmin when your phone does).` : ", from Garmin Connect."}
        </p>
        {live.notes.length > 0 && <p className="text-[11px] text-amber-300/80">{live.notes.join(" · ")}</p>}
      </div>

      <Sortable section="today-panels" editing={editing} layoutVersion={layoutVersion} className="space-y-4 min-w-0">
        <Panel key="stress" title="Stress and Body Battery" legend={[
          { name: "Body Battery", color: GREEN, pts: live.bodyBattery },
          { name: "Stress Level", color: BLUE, pts: live.stress, digits: 1 },
        ]}>
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={stressBb} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="stressFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={RED} stopOpacity={0.55} /><stop offset="45%" stopColor={AMBER} stopOpacity={0.3} /><stop offset="100%" stopColor="#3b82f6" stopOpacity={0.12} />
                </linearGradient>
              </defs>
              {grid}{xAxis}
              <YAxis domain={[0, 100]} tick={tick} axisLine={false} tickLine={false} width={28} />
              <Tooltip {...tip} labelFormatter={v => clock(Number(v))} />
              <Area dataKey="stress" name="Stress" stroke={AMBER} strokeWidth={1.5} fill="url(#stressFill)" dot={false} connectNulls isAnimationActive={false} />
              <Line dataKey="bb" name="Body Battery" stroke={GREEN} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </Panel>

        <Panel key="steps-cum" title="Steps Cumulative (24h)" legend={[{ name: "Intraday Steps", color: BLUE, pts: live.stepsCum }]}>
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={live.stepsCum} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
              {grid}{xAxis}
              <YAxis domain={[0, maxSteps]} tick={tick} axisLine={false} tickLine={false} width={40} />
              <ReferenceArea y1={0} y2={2000} fill={RED} fillOpacity={0.12} />
              <ReferenceArea y1={2000} y2={6000} fill={AMBER} fillOpacity={0.08} />
              <ReferenceArea y1={6000} y2={goal} fill={GREEN} fillOpacity={0.08} />
              <ReferenceArea y1={goal} y2={maxSteps} fill={BLUE} fillOpacity={0.1} />
              <Tooltip {...tip} labelFormatter={v => clock(Number(v))} />
              <Line dataKey="v" name="Steps" type="stepAfter" stroke={AMBER} strokeWidth={2} dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </Panel>

        <Panel key="steps-hourly" title="Steps Hourly (24h)">
          <div className="flex gap-px">
            {live.stepsHourly.map(h => (
              <div key={h.t} title={`${clock(h.t)} — ${h.v} steps`} className="flex-1 min-w-0 rounded-sm h-9 flex items-end justify-center text-[9px] text-slate-200/80"
                style={{ background: h.v === 0 ? "rgba(255,255,255,0.03)" : `rgba(52,211,153,${0.15 + 0.6 * (h.v / hourMax)})` }}>
                {h.v > 0 ? h.v : ""}
              </div>
            ))}
          </div>
          <div className="flex gap-px mt-1">
            {live.stepsHourly.map((h, i) => (
              <div key={h.t} className="flex-1 min-w-0 text-center text-[9px] text-slate-600">{i % 3 === 0 ? String(new Date(h.t).getHours()).padStart(2, "0") : ""}</div>
            ))}
          </div>
        </Panel>

        <Panel key="sleep-stages" title="Sleep Stages">
          {live.sleepStages ? (() => {
            const lv = { deep: 0, light: 1, rem: 2, awake: 3 } as const;
            const pts = live.sleepStages.stages.flatMap(g => [{ t: g.start, level: lv[g.stage] }, { t: g.end, level: lv[g.stage] }]);
            const lo = live.sleepStages.start - 30 * 60_000, hi = live.sleepStages.end + 30 * 60_000;
            const tot: Record<string, number> = { deep: 0, light: 0, rem: 0, awake: 0 };
            live.sleepStages.stages.forEach(g => { tot[g.stage] += g.end - g.start; });
            const dur = (ms: number) => `${Math.floor(ms / 3_600_000)}h ${String(Math.round((ms % 3_600_000) / 60_000)).padStart(2, "0")}m`;
            const first = Math.ceil(lo / 3600_000) * 3600_000;
            const ticks: number[] = [];
            for (let t = first, i = 0; t <= hi; t += 3600_000, i++) if (i % 2 === 0) ticks.push(t);
            return (
              <>
                <ResponsiveContainer width="100%" height={200}>
                  <ComposedChart data={pts} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                    <XAxis dataKey="t" type="number" scale="time" domain={[lo, hi]} tick={tick} tickFormatter={clock} axisLine={{ stroke: "rgba(255,255,255,0.08)" }} tickLine={false} ticks={ticks} />
                    <YAxis type="number" domain={[-0.5, 3.5]} ticks={[0, 1, 2, 3]} tickFormatter={v => ["Deep", "Light", "REM", "Awake"][Number(v)] ?? ""} tick={tick} axisLine={false} tickLine={false} width={42} />
                    <ReferenceArea y1={2.5} y2={3.5} fill={RED} fillOpacity={0.1} />
                    <ReferenceArea y1={1.5} y2={2.5} fill={AMBER} fillOpacity={0.1} />
                    <ReferenceArea y1={0.5} y2={1.5} fill="#94a3b8" fillOpacity={0.08} />
                    <ReferenceArea y1={-0.5} y2={0.5} fill="#3b82f6" fillOpacity={0.14} />
                    <Tooltip {...tip} labelFormatter={v => clock(Number(v))} formatter={v => [["Deep", "Light", "REM", "Awake"][Number(v)], "Stage"]} />
                    <Line dataKey="level" name="Stage" type="stepAfter" stroke="#e2e8f0" strokeWidth={1.6} dot={false} isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
                <p className="text-[11px] text-slate-500 mt-1">
                  Night ending this day, {clock(live.sleepStages.start)} – {clock(live.sleepStages.end)} · Deep {dur(tot.deep)} · Light {dur(tot.light)} · REM {dur(tot.rem)} · Awake {dur(tot.awake)}
                </p>
              </>
            );
          })() : <p className="text-sm text-slate-500">No sleep stages recorded for this day.</p>}
        </Panel>

        <Panel key="hr" title="Heart Rate" legend={[{ name: "Heart rate (bpm)", color: RED, pts: live.hr }]}>
          <ResponsiveContainer width="100%" height={200}>
            <ComposedChart data={live.hr} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="hrFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={RED} stopOpacity={0.45} /><stop offset="100%" stopColor={RED} stopOpacity={0.03} />
                </linearGradient>
              </defs>
              {grid}{xAxis}
              <YAxis domain={["dataMin - 5", "dataMax + 5"]} tick={tick} axisLine={false} tickLine={false} width={30} allowDecimals={false} />
              <Tooltip {...tip} labelFormatter={v => clock(Number(v))} />
              <Area dataKey="v" name="Heart rate" stroke={RED} strokeWidth={1.5} fill="url(#hrFill)" dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </Panel>

        <div key="breath-spo2" className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <Panel title="Breathing Rates" legend={[{ name: "Breathing rate (brpm)", color: PURPLE, pts: live.rr, digits: 1 }]}>
            <ResponsiveContainer width="100%" height={180}>
              <ComposedChart data={live.rr} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
                {grid}{xAxis}
                <YAxis domain={["dataMin - 2", "dataMax + 2"]} tick={tick} axisLine={false} tickLine={false} width={28} allowDecimals={false} />
                <Tooltip {...tip} labelFormatter={v => clock(Number(v))} />
                <Line dataKey="v" name="Breathing rate" stroke={PURPLE} strokeWidth={1.8} dot={false} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </Panel>
          <Panel title="SpO2" legend={[{ name: "SpO2 (%)", color: GREEN, pts: live.spo2 }]}>
            <ResponsiveContainer width="100%" height={180}>
              <ComposedChart data={live.spo2} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
                {grid}{xAxis}
                <YAxis domain={[80, 100]} tick={tick} axisLine={false} tickLine={false} width={28} />
                <ReferenceArea y1={80} y2={90} fill={RED} fillOpacity={0.1} />
                <Tooltip {...tip} labelFormatter={v => clock(Number(v))} />
                <Line dataKey="v" name="SpO2" stroke={GREEN} strokeWidth={1.8} dot={false} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </Panel>
        </div>
      </Sortable>
    </div>

    </>
  );
}

function TrainingStatusPanel({ ts }: { ts: Live["trainingStatus"] }) {
  const label = useContext(DayLabelCtx);
  return (
    <section className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-100 mb-2">Training Status<span className="text-[11px] font-normal text-sky-400/80">⏱ {label}</span></h3>
      {!ts ? <p className="text-sm text-slate-500">No training status from Garmin for this day.</p> : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-x-6 gap-y-1">
            <div><p className="text-[11px] text-slate-500">Status</p><p className="text-xl font-semibold text-slate-100">{ts.label ?? "—"}</p></div>
            <div><p className="text-[11px] text-slate-500">VO2 max</p><p className="text-xl font-semibold text-slate-100 tabular-nums">{ts.vo2Max != null ? ts.vo2Max.toFixed(1) : "—"}</p></div>
            <div><p className="text-[11px] text-slate-500">Load ratio</p><p className="text-xl font-semibold text-slate-100 tabular-nums">{ts.ratio != null ? ts.ratio.toFixed(1) : "—"}<span className="text-xs font-normal text-slate-400 ml-1.5">{ts.acwrStatus ?? ""}</span></p></div>
          </div>
          {ts.acute != null && ts.chronic != null && (
            <div className="space-y-2">
              <RangeBar label="Acute load (7 days)" value={ts.acute} lo={ts.tunnelMin ?? 0} hi={ts.tunnelMax ?? 0} max={Math.max(ts.acute, ts.tunnelMax ?? 0, ts.chronic) * 1.25} color="#38bdf8" />
              <RangeBar label="Chronic load (4 weeks)" value={ts.chronic} lo={ts.tunnelMin ?? 0} hi={ts.tunnelMax ?? 0} max={Math.max(ts.acute, ts.tunnelMax ?? 0, ts.chronic) * 1.25} color="#a78bfa" />
            </div>
          )}
          {ts.balance && (
            <div className="space-y-2 pt-1 border-t border-white/5">
              <p className="text-[11px] text-slate-500 pt-2">Load balance, last 4 weeks{ts.balance.feedback ? ` · ${ts.balance.feedback}` : ""}</p>
              <RangeBar label="Aerobic low" value={ts.balance.aerobicLow} lo={ts.balance.lowMin} hi={ts.balance.lowMax} max={Math.max(ts.balance.aerobicLow, ts.balance.lowMax) * 1.2 || 1} color="#34d399" />
              <RangeBar label="Aerobic high" value={ts.balance.aerobicHigh} lo={ts.balance.highMin} hi={ts.balance.highMax} max={Math.max(ts.balance.aerobicHigh, ts.balance.highMax) * 1.2 || 1} color="#fbbf24" />
              <RangeBar label="Anaerobic" value={ts.balance.anaerobic} lo={ts.balance.anMin} hi={ts.balance.anMax} max={Math.max(ts.balance.anaerobic, ts.balance.anMax) * 1.2 || 1} color="#f43f5e" />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function RacePredictionsPanel({ rp }: { rp: Live["racePredictions"] }) {
  const label = useContext(DayLabelCtx);
  const rows: { key: "s5k" | "s10k" | "half" | "full"; name: string; color: string }[] = [
    { key: "s5k", name: "Time 5K", color: "#a78bfa" }, { key: "s10k", name: "Time 10K", color: "#34d399" },
    { key: "half", name: "Half Marathon", color: "#fbbf24" }, { key: "full", name: "Full Marathon", color: "#38bdf8" },
  ];
  return (
    <section className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-100 mb-2">Race Predictions<span className="text-[11px] font-normal text-sky-400/80">⏱ 90 days to {label}</span></h3>
      {!rp ? <p className="text-sm text-slate-500">No race predictions from Garmin.</p> : (
        <>
          <div className="grid grid-cols-2 gap-3">
            {rows.map(r => (
              <div key={r.key}>
                <p className="text-[11px] text-slate-400 flex justify-between"><span>{r.name}</span><span className="tabular-nums text-slate-200 font-medium">{hms(rp.latest?.[r.key])}</span></p>
                <ResponsiveContainer width="100%" height={90}>
                  <ComposedChart data={rp.history} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                    <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} hide />
                    <YAxis domain={["dataMin - 20", "dataMax + 20"]} hide reversed />
                    <Tooltip {...tip} labelFormatter={v => new Date(Number(v)).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} formatter={v => [hms(Number(v)), r.name]} />
                    <Line dataKey={r.key} stroke={r.color} strokeWidth={2} dot={false} isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            ))}
          </div>
          <table className="w-full text-[11px] mt-2">
            <thead><tr className="text-slate-500 border-b border-white/10"><th className="text-left font-medium py-1">Name</th><th className="text-right font-medium w-20">Min</th><th className="text-right font-medium w-20">Max</th><th className="text-right font-medium w-20">Mean</th><th className="text-right font-medium w-20">Last</th></tr></thead>
            <tbody>
              {rows.map(r => {
                const v = rp.history.map(h => h[r.key]);
                return (
                  <tr key={r.key} className="text-slate-300 border-b border-white/5">
                    <td className="py-1"><span className="inline-block w-3 h-0.5 align-middle mr-2" style={{ background: r.color }} />{r.name}</td>
                    <td className="text-right tabular-nums">{hms(Math.min(...v))}</td><td className="text-right tabular-nums">{hms(Math.max(...v))}</td>
                    <td className="text-right tabular-nums">{hms(v.reduce((a, b) => a + b, 0) / v.length)}</td><td className="text-right tabular-nums text-slate-100">{hms(v[v.length - 1])}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function ScorePanel({ title, badge, children }: { title: string; badge: string; children: ReactNode }) {
  return (
    <section className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-100 mb-2">{title}<span className="text-[11px] font-normal text-sky-400/80">⏱ {badge}</span></h3>
      {children}
    </section>
  );
}

function HillScorePanel({ hs }: { hs: Live["hillScore"] }) {
  const label = useContext(DayLabelCtx);
  return (
    <ScorePanel title="Hill Score" badge={`90 days to ${label}`}>
      {!hs ? <p className="text-sm text-slate-500">No hill score from Garmin.</p> : (
        <>
          <div className="flex flex-wrap items-end gap-x-6 gap-y-1 mb-1">
            <div><p className="text-[11px] text-slate-500">Hill score</p><p className="text-3xl font-semibold text-slate-100 tabular-nums">{hs.overall ?? "—"}</p></div>
            <div><p className="text-[11px] text-slate-500">Strength</p><p className="text-xl font-semibold tabular-nums" style={{ color: "#fbbf24" }}>{hs.strength ?? "—"}</p></div>
            <div><p className="text-[11px] text-slate-500">Endurance</p><p className="text-xl font-semibold tabular-nums" style={{ color: "#38bdf8" }}>{hs.endurance ?? "—"}</p></div>
          </div>
          <ResponsiveContainer width="100%" height={150}>
            <ComposedChart data={hs.history} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} tick={tick} tickFormatter={v => new Date(Number(v)).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} axisLine={{ stroke: "rgba(255,255,255,0.08)" }} tickLine={false} minTickGap={40} />
              <YAxis domain={["dataMin - 3", "dataMax + 3"]} tick={tick} axisLine={false} tickLine={false} width={28} allowDecimals={false} />
              <Tooltip {...tip} labelFormatter={v => new Date(Number(v)).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} />
              <Line dataKey="overall" name="Hill score" stroke="#e2e8f0" strokeWidth={2.2} dot={false} isAnimationActive={false} />
              <Line dataKey="strength" name="Strength" stroke="#fbbf24" strokeWidth={1.5} dot={false} isAnimationActive={false} />
              <Line dataKey="endurance" name="Endurance" stroke="#38bdf8" strokeWidth={1.5} dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </>
      )}
    </ScorePanel>
  );
}

function LactatePanel({ lt }: { lt: Live["lactate"] }) {
  const label = useContext(DayLabelCtx);
  const paceMi = (ms: number | null) => { if (!ms || ms <= 0) return "—"; const s = 1609.344 / ms; return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`; };
  const paceKm = (ms: number | null) => { if (!ms || ms <= 0) return "—"; const s = 1000 / ms; return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`; };
  const hist = (lt?.history ?? []).map(h => ({ ...h, pace: h.speedMs ? 1609.344 / h.speedMs / 60 : null }));
  return (
    <ScorePanel title="Lactate Threshold" badge={`90 days to ${label}`}>
      {!lt ? <p className="text-sm text-slate-500">No lactate threshold from Garmin.</p> : (
        <>
          <div className="flex flex-wrap items-end gap-x-6 gap-y-1 mb-1">
            <div><p className="text-[11px] text-slate-500">Heart rate</p><p className="text-3xl font-semibold text-slate-100 tabular-nums">{lt.hr ?? "—"}<span className="text-sm text-slate-400 ml-1">bpm</span></p></div>
            <div><p className="text-[11px] text-slate-500">Pace</p><p className="text-xl font-semibold tabular-nums" style={{ color: "#38bdf8" }}>{paceMi(lt.speedMs)}<span className="text-xs text-slate-400 ml-1">/mi</span></p></div>
            <div><p className="text-[11px] text-slate-500">&nbsp;</p><p className="text-sm text-slate-400 tabular-nums">{paceKm(lt.speedMs)} /km</p></div>
          </div>
          {lt.date && <p className="text-[11px] text-slate-500 mb-1">Last measured {new Date(lt.date + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</p>}
          {hist.length > 1 && (
            <ResponsiveContainer width="100%" height={150}>
              <ComposedChart data={hist} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} tick={tick} tickFormatter={v => new Date(Number(v)).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} axisLine={{ stroke: "rgba(255,255,255,0.08)" }} tickLine={false} minTickGap={40} />
                <YAxis yAxisId="hr" domain={["dataMin - 3", "dataMax + 3"]} tick={tick} axisLine={false} tickLine={false} width={28} allowDecimals={false} />
                <YAxis yAxisId="pace" orientation="right" reversed domain={["dataMin - 0.1", "dataMax + 0.1"]} tick={tick} axisLine={false} tickLine={false} width={34} tickFormatter={v => `${Math.floor(Number(v))}:${String(Math.round((Number(v) % 1) * 60)).padStart(2, "0")}`} />
                <Tooltip {...tip} labelFormatter={v => new Date(Number(v)).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} formatter={(v, n) => n === "Pace /mi" ? [`${Math.floor(Number(v))}:${String(Math.round((Number(v) % 1) * 60)).padStart(2, "0")}`, n] : [v, n]} />
                <Line yAxisId="hr" dataKey="hr" name="Heart rate" stroke="#f87171" strokeWidth={2} dot={{ r: 3 }} connectNulls isAnimationActive={false} />
                <Line yAxisId="pace" dataKey="pace" name="Pace /mi" stroke="#38bdf8" strokeWidth={2} dot={{ r: 3 }} connectNulls isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </>
      )}
    </ScorePanel>
  );
}

function EnduranceScorePanel({ es }: { es: Live["enduranceScore"] }) {
  const label = useContext(DayLabelCtx);
  return (
    <ScorePanel title="Endurance Score" badge={`90 days to ${label}`}>
      {!es ? <p className="text-sm text-slate-500">No endurance score from Garmin.</p> : (
        <>
          <div className="flex flex-wrap items-end gap-x-6 gap-y-1 mb-1">
            <div><p className="text-[11px] text-slate-500">Endurance score</p><p className="text-3xl font-semibold text-slate-100 tabular-nums">{es.score ?? "—"}</p></div>
            <div><p className="text-[11px] text-slate-500">Level</p><p className="text-xl font-semibold text-emerald-300">{es.label ?? "—"}</p></div>
          </div>
          <ResponsiveContainer width="100%" height={150}>
            <ComposedChart data={es.history} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} tick={tick} tickFormatter={v => new Date(Number(v)).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} axisLine={{ stroke: "rgba(255,255,255,0.08)" }} tickLine={false} minTickGap={40} />
              <YAxis domain={["dataMin - 100", "dataMax + 100"]} tick={tick} axisLine={false} tickLine={false} width={38} allowDecimals={false} />
              {es.bands.map((b, i) => {
                const next = es.bands[i + 1]?.from;
                return next != null ? <ReferenceLine key={b.name} y={next} stroke="rgba(148,163,184,0.25)" strokeDasharray="3 3" label={{ value: es.bands[i + 1].name, position: "insideTopRight", fill: "#64748b", fontSize: 9 }} /> : null;
              })}
              <Tooltip {...tip} labelFormatter={v => `Week of ${new Date(Number(v)).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`} />
              <Line dataKey="v" name="Endurance score" stroke="#34d399" strokeWidth={2.2} dot={{ r: 2.5 }} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </>
      )}
    </ScorePanel>
  );
}
