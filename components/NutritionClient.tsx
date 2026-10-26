"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bar, CartesianGrid, ComposedChart, Legend, Line, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
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
  net: number | null;
  partial?: boolean;
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
  method: "trend" | "trend7" | "energy" | "plan" | "postrun";
  label: string;
  basis: string;
  kgPerWeek: number;
  weightAtGoalKg: number | null;
  hitDate: string | null;
  hitStatus: "reached" | "on-course" | "never";
  anchorKg?: number; // where this projection starts today (the 7-day average, or the end of its own fitted trend line)
  rawKgPerWeek: number;
  capped: boolean;
}
interface Dashboard {
  config: {
    targetWeightKg: number | null;
    goalDate: string | null;
    dailyCalorieLimit: number | null;
    minDailyCalories?: number; // eating less than this in a day shows red
    weightUnit: WeightUnit;
    trendDays: number;
    kcalPerKg: number;
  };
  today: string;
  days: DayRow[];
  weights: { date: string; kg: number }[];
  postRunWeights?: { date: string; kg: number }[]; // weigh-ins taken within 3 hours after a run
  current: { kg: number; date: string; avg7Kg: number; measuredAt: string | null; source: "Garmin" | "Health Connect"; postRun?: boolean; regularKg?: number; regularDate?: string } | null;
  averages: {
    eaten: number | null; burnt: number | null; exercise: number | null; deficit: number | null; net: number | null;
    loggedDays: number; windowDays: number; deficit7: number | null; deficit7Days: number;
  };
  projections: Projection[];
  required: { kgPerWeek: number; dailyBalance: number; intake: number | null } | null;
  trendFit: { startDate: string; startKg: number; endDate: string; endKg: number } | null;
  trendFit7: { startDate: string; startKg: number; endDate: string; endKg: number } | null;
  postRunFit?: { startDate: string; startKg: number; endDate: string; endKg: number } | null;
  sources: { garminWeight: string | null; todayBurn: string | null; food: string | null; garminDb: string | null };
}

const AUTO_REFRESH_MS = 15 * 60_000;

// "18:42" today, "Thu 06:04" otherwise.
function stamp(iso: string | null | undefined): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "?";
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString("en-GB", { weekday: "short" })} ${time}`;
}

const RANGES = [14, 30, 90] as const;
const RANGE_KEY = "nutrition.chartRange";
const DAY_MS = 86_400_000;
// Rectangle with rounded top corners, as the bars have.
function topRounded(x: number, y: number, w: number, h: number, r: number): string {
  const k = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h} L${x},${y + k} Q${x},${y} ${x + k},${y} L${x + w - k},${y} Q${x + w},${y} ${x + w},${y + k} L${x + w},${y + h} Z`;
}

// A day on which less than the daily minimum has been eaten (today counts: it
// stays red until the minimum is reached).
function underMinimum(d: DayRow | undefined, minKcal: number): boolean {
  return d?.eaten != null && d.eaten < minKcal;
}

// The Eaten bar. Its top part is white and as tall as that day's exercise (the
// Exercise bar), so the amber below it is eaten − exercise. If exercise is
// more than was eaten that is negative: the white covers the whole bar and
// carries on below the zero line.
function EatenBar({ x = 0, y = 0, width = 0, height = 0, payload, showTip, minKcal }: {
  x?: number; y?: number; width?: number; height?: number; payload?: DayRow; showTip: boolean;
  minKcal: number;
}) {
  if (height <= 0 || width <= 0) return null;
  const eaten = payload?.eaten ?? 0;
  const low = underMinimum(payload, minKcal);
  const exercise = showTip ? Math.max(payload?.exercise ?? 0, 0) : 0;
  const tipH = eaten > 0 ? height * (exercise / eaten) : 0; // pixels per kcal is height / eaten
  return (
    <g>
      <path d={topRounded(x, y, width, height, 2)} fill={low ? "#ff0012" : C.eaten} />
      {/* The exercise tip is white, or a slightly lighter red (#ef4444 on #ff0012) while under the minimum, so it still shows against the bar */}
      {tipH > 0 && <path d={topRounded(x, y, width, tipH, 2)} fill={low ? "#ef4444" : "#ffffff"} />}
    </g>
  );
}

const PROJ_COLORS: Record<Projection["method"], string> = { trend: "#a78bfa", trend7: "#fb7185", energy: "#f59e0b", plan: "#38bdf8", postrun: "#22c55e" };

// y-axis grid lines for a weight chart in stone: every half stone (7 lb), so
// the labels are only ever whole or half stones (every whole stone if the range
// is big enough that this would crowd). Same as the app's chart.
function halfStoneTicks(lo: number, hi: number): number[] {
  const loLb = lo * LB_PER_KG, hiLb = hi * LB_PER_KG;
  const step = (hiLb - loLb) / 7 > 12 ? 14 : 7;
  const out: number[] = [];
  for (let lb = Math.ceil(loLb / step) * step; lb <= hiLb + 1e-9; lb += step) out.push(lb / LB_PER_KG);
  return out;
}

const C = {
  eaten: "#f59e0b",
  burnt: "#38bdf8",
  exercise: "#34d399",
  limit: "#f87171",
  deficit: "#e879f9",
  netOk: "#22c55e",
  netLine: "#cbd5e1",
  netOver: "#ef4444",
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

function Stat({ label, value, sub, action }: { label: string; value: string; sub?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-4 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-slate-500">{label}</div>
        {action}
      </div>
      <div className="text-2xl font-semibold text-slate-100 mt-1 tabular-nums truncate">{value}</div>
      {sub && <div className="text-xs text-slate-400 mt-1">{sub}</div>}
    </div>
  );
}

function CaloriesTooltip({ active, payload, label }: { active?: boolean; payload?: { payload: DayRow }[]; label?: string }) {
  if (!active || !payload?.length || !label) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-lg bg-slate-950/95 border border-white/10 px-3 py-2 text-xs space-y-0.5 shadow-lg">
      <div className="font-medium text-slate-200 mb-1">{longDate(label)}</div>
      <div style={{ color: C.eaten }}>Eaten: {kcal(d.eaten)} kcal</div>
      <div style={{ color: C.burnt }}>Burnt{d.partial ? " so far" : ""}: {kcal(d.burnt)} kcal{d.resting != null ? ` (${kcal(d.resting)} resting)` : ""}</div>
      <div style={{ color: C.exercise }}>Exercise: {kcal(d.exercise)} kcal</div>

      {d.net != null && (
        <div className={d.net <= 0 ? "text-emerald-300" : "text-rose-300"}>
          Net (eaten − burnt){d.partial ? " so far" : ""}: {d.net > 0 ? "+" : d.net < 0 ? "−" : ""}{kcal(Math.abs(d.net))} kcal ({d.net <= 0 ? "deficit" : "gain"})
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

// Splits the summary at its bold/# heading lines: [{ title, body }]. Text
// before the first heading becomes an untitled section.
function summarySections(text: string): { title: string | null; body: string }[] {
  const out: { title: string | null; body: string[] }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const h = line.match(/^\*\*([^*]+)\*\*:?$/) ?? line.match(/^#{1,4}\s+(.*)$/);
    if (h) out.push({ title: h[1].trim(), body: [] });
    else {
      if (!out.length) out.push({ title: null, body: [] });
      out[out.length - 1].body.push(raw);
    }
  }
  return out.map(s => ({ title: s.title, body: s.body.join("\n").trim() })).filter(s => s.title || s.body);
}

// Opens the Coach page and sends `message` there as the user's message.
function useDiscussWithCoach() {
  const router = useRouter();
  return (message: string) => {
    try { window.sessionStorage.setItem("coach.discuss", message); } catch {}
    router.push("/coach");
  };
}

function DiscussButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} title={label}
      className="shrink-0 text-[11px] px-2 py-0.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 transition-colors">
      💬 Discuss
    </button>
  );
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

  const discuss = useDiscussWithCoach();

  // Click the title to minimise; remembered in this browser.
  const [collapsed, setCollapsed] = useState(() => {
    try { return window.localStorage.getItem("nutrition.summaryCollapsed") === "1"; } catch { return false; }
  });
  const toggleCollapsed = () => setCollapsed(c => {
    try { window.localStorage.setItem("nutrition.summaryCollapsed", c ? "0" : "1"); } catch {}
    return !c;
  });

  // Bumped by the refresh button to restart polling after a forced rewrite.
  const [run, setRun] = useState(0);
  const [forcing, setForcing] = useState(false);

  const poll = useCallback(async (method: "GET" | "POST", force = false) => {
    try {
      const res = await fetch(`/api/nutrition/summary${force ? "?force=1" : ""}`, { method });
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
    // After a refresh the server is already writing: start by checking in.
    if (run > 0) timer = setTimeout(() => tick(false), 10_000); else tick(true);
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [poll, run]);

  // Write a fresh summary now (thinking mode, in the background; can take a few minutes).
  async function regenerate() {
    setForcing(true);
    const d = await poll("POST", true);
    setForcing(false);
    if (d?.writing) setRun(r => r + 1);
  }

  const waiting = s?.due && !s.writing;
  return (
    <Card>
      <div className={`flex items-center justify-between gap-3 ${collapsed ? "" : "mb-3"}`}>
        <button onClick={toggleCollapsed} aria-expanded={!collapsed}
          className="flex items-center gap-2 text-sm font-semibold text-slate-300 hover:text-slate-100 transition-colors text-left"
          title={collapsed ? "Show the summary" : "Minimise the summary"}>
          <span className={`text-[10px] text-slate-500 transition-transform ${collapsed ? "-rotate-90" : ""}`}>▼</span>
          🧠 AI summary · last 14 days
        </button>
        <div className="flex items-center gap-3">
          {s?.summary && (
            <span className="text-[11px] text-slate-500 text-right">
              {whenLabel(s.summary.createdAt)}{s.summary.model ? ` · ${s.summary.model}` : ""}
            </span>
          )}
          {s?.summary && (
            <DiscussButton label="Discuss the whole summary with the coach" onClick={() => discuss(
              `Let's discuss my nutrition summary for ${s.summary!.periodStart} to ${s.summary!.periodEnd}:\n\n${s.summary!.content}`,
            )} />
          )}
          <button
            onClick={regenerate}
            disabled={forcing || !!s?.writing}
            title="Write a fresh summary now (uses thinking; can take a few minutes)"
            aria-label="Write a fresh summary now"
            className="text-slate-500 hover:text-slate-200 disabled:opacity-50 transition-colors -m-1 p-1"
          >
            <svg viewBox="0 0 24 24" className={`h-4 w-4 ${forcing || s?.writing ? "animate-spin" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
          </button>
        </div>
      </div>
      {!collapsed && <>
      {s?.writing && <p className="text-xs text-emerald-300 mb-3 animate-pulse">Writing the summary (thinking mode; this can take a few minutes)…</p>}
      {s?.result?.status === "unavailable" && !s.due && <p className="text-xs text-amber-300 mb-3">Couldn&apos;t refresh: {s.result.reason}.</p>}
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
          <div className="space-y-3">
            {summarySections(s.summary.content).map((sec, i) => (
              <div key={i}>
                {sec.title && (
                  <div className="flex items-center justify-between gap-3 mb-1">
                    <h3 className="text-sm font-semibold text-slate-100">{sec.title}</h3>
                    <DiscussButton label={`Discuss "${sec.title}" with the coach`} onClick={() => discuss(
                      `Let's discuss the "${sec.title}" section of my nutrition summary for ${s.summary!.periodStart} to ${s.summary!.periodEnd}:\n\n${sec.body}`,
                    )} />
                  </div>
                )}
                {sec.body && <SummaryMarkdown text={sec.body} />}
              </div>
            ))}
          </div>
          {!s.due && <p className="text-[11px] text-slate-500 mt-3">Next summary from {whenLabel(s.nextAt)}.</p>}
        </>
      ) : (
        <p className="text-sm text-slate-500">No summary yet.</p>
      )}
      </>}
    </Card>
  );
}

// Wheel / drag / touch zoom for a chart's numeric x-domain, like the tracklist
// chart: wheel zooms around the cursor (a sideways swipe pans), dragging pans,
// pinch zooms and one finger pans on touch. `domain` is null at full view.
function useChartZoom(dataMin: number, dataMax: number, minSpan: number) {
  // A callback ref held in state: the charts only mount once their data has
  // loaded, so the listeners must attach when the element appears, not at
  // the component's first render.
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [domain, setDomain] = useState<[number, number] | null>(null);
  const domainRef = useRef(domain);
  domainRef.current = domain;
  const bounds = useRef({ dataMin, dataMax, minSpan });
  bounds.current = { dataMin, dataMax, minSpan };

  const apply = useCallback((lo: number, hi: number) => {
    const { dataMin: min, dataMax: max } = bounds.current;
    const full = max - min;
    const span = Math.min(full, hi - lo);
    let l = Math.max(min, lo);
    let h = l + span;
    if (h > max) { h = max; l = h - span; }
    setDomain(span >= full - 1e-6 ? null : [l, h]);
  }, []);
  const reset = useCallback(() => setDomain(null), []);

  useEffect(() => {
    if (!el) return;
    const valid = () => bounds.current.dataMax > bounds.current.dataMin;
    const cur = (): [number, number] => domainRef.current ?? [bounds.current.dataMin, bounds.current.dataMax];
    const frac = (x: number) => {
      const r = el.getBoundingClientRect();
      return Math.min(1, Math.max(0, (x - r.left) / Math.max(1, r.width)));
    };
    const zoomAround = (lo: number, hi: number, f: number, factor: number) => {
      const center = lo + f * (hi - lo);
      const span = Math.max(bounds.current.minSpan, (hi - lo) * factor);
      apply(center - f * span, center - f * span + span);
    };

    const onWheel = (e: WheelEvent) => {
      if (!valid()) return;
      e.preventDefault();
      const [lo, hi] = cur();
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const d = (e.deltaX / Math.max(1, el.getBoundingClientRect().width)) * (hi - lo);
        apply(lo + d, hi + d);
        return;
      }
      zoomAround(lo, hi, frac(e.clientX), e.deltaY > 0 ? 1.25 : 0.8);
    };

    let drag: { x: number; lo: number; hi: number } | null = null;
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || !valid()) return;
      const [lo, hi] = cur();
      drag = { x: e.clientX, lo, hi };
    };
    const onMove = (e: MouseEvent) => {
      if (!drag) return;
      const d = ((e.clientX - drag.x) / Math.max(1, el.getBoundingClientRect().width)) * (drag.hi - drag.lo);
      if (Math.abs(e.clientX - drag.x) > 2) el.style.cursor = "grabbing";
      apply(drag.lo - d, drag.hi - d);
    };
    const onUp = () => { drag = null; el.style.cursor = ""; };

    let panX: number | null = null;
    let panFrom: [number, number] | null = null;
    let pinchDist: number | null = null;
    let pinchFrom: [number, number] | null = null;
    let pinchFrac = 0.5;
    const dist = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const onTouchStart = (e: TouchEvent) => {
      if (!valid()) return;
      if (e.touches.length === 2) {
        e.preventDefault();
        panX = null;
        pinchDist = dist(e.touches[0], e.touches[1]);
        pinchFrom = cur();
        pinchFrac = frac((e.touches[0].clientX + e.touches[1].clientX) / 2);
      } else if (e.touches.length === 1) {
        pinchDist = null;
        panX = e.touches[0].clientX;
        panFrom = cur();
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!valid()) return;
      if (e.touches.length === 2 && pinchDist != null && pinchFrom) {
        e.preventDefault();
        const scale = pinchDist / Math.max(1, dist(e.touches[0], e.touches[1]));
        zoomAround(pinchFrom[0], pinchFrom[1], pinchFrac, scale);
      } else if (e.touches.length === 1 && panX != null && panFrom && domainRef.current) {
        // One finger pans only when zoomed in, so the page still scrolls at full view.
        e.preventDefault();
        const d = ((e.touches[0].clientX - panX) / Math.max(1, el.getBoundingClientRect().width)) * (panFrom[1] - panFrom[0]);
        apply(panFrom[0] - d, panFrom[1] - d);
      }
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length === 0) { panX = null; pinchDist = null; }
      else if (e.touches.length === 1) { pinchDist = null; panX = e.touches[0].clientX; panFrom = cur(); }
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    el.addEventListener("touchstart", onTouchStart, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [el, apply]);

  return { ref: setEl, domain, reset };
}

export function NutritionClient() {
  // Chart range is remembered in this browser across refreshes.
  const [range, setRangeState] = useState<(typeof RANGES)[number]>(() => {
    try {
      const v = Number(window.localStorage.getItem(RANGE_KEY));
      return (RANGES as readonly number[]).includes(v) ? (v as (typeof RANGES)[number]) : 30;
    } catch {
      return 30;
    }
  });
  const setRange = (r: (typeof RANGES)[number]) => {
    setRangeState(r);
    try { window.localStorage.setItem(RANGE_KEY, String(r)); } catch {}
  };
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (days: number) => {
    setError(null);
    try {
      const res = await fetch(`/api/nutrition/dashboard?days=${days}`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `Failed (${res.status})`);
      setData(d);
      setLoadedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, []);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => { load(range); }, [range, load]);
  // Reload every 15 minutes (today's burn is refreshed from Garmin at most
  // that often), and tick the countdown every 30s.
  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
      if (loadedAt != null && Date.now() - loadedAt >= AUTO_REFRESH_MS) load(range);
    }, 30_000);
    return () => clearInterval(t);
  }, [loadedAt, load, range]);

  // Pull the latest weigh-ins from Garmin Connect, then reload the page data.
  const [weightRefresh, setWeightRefresh] = useState<{ busy: boolean; msg: string | null }>({ busy: false, msg: null });
  const refreshWeight = useCallback(async () => {
    setWeightRefresh({ busy: true, msg: null });
    try {
      const res = await fetch("/api/nutrition/weight-refresh", { method: "POST" });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `Failed (${res.status})`);
      await load(range);
      setWeightRefresh({ busy: false, msg: d.latest ? `Garmin: latest ${shortDate(d.latest.date)}` : "No weigh-ins in Garmin" });
    } catch (e) {
      setWeightRefresh({ busy: false, msg: e instanceof Error ? e.message : "Refresh failed" });
    }
  }, [load, range]);

  // Get Garmin's latest weigh-in once when the page opens.
  useEffect(() => { refreshWeight(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Click a legend entry to hide/show that series.
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const toggleSeries = (key: string) => setHidden(h => {
    const next = new Set(h);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  // Chart zoom (wheel / drag / pinch). The calories chart is categorical, so
  // its zoom window is a span of day indices, at least a week wide.
  const nDays = data?.days.length ?? 0;
  const calZoom = useChartZoom(0, Math.max(0, nDays - 1), 6);
  const resetCalZoom = calZoom.reset;
  useEffect(() => { resetCalZoom(); }, [range, resetCalZoom]);

  const unit = data?.config.weightUnit ?? "st";
  const cfg = data?.config;
  const today = data?.today;
  const todayRow = data?.days.find(d => d.date === today);

  // Weight chart: history + a straight projection line per method from the
  // current 7-day average out to the later of the goal date / hit date.
  const weightChart = useMemo(() => {
    if (!data || !data.current || !today) return null;
    const startMs = toMs(today) - 56 * DAY_MS;
    const history = data.weights.filter(w => toMs(w.date) >= startMs).map(w => ({ t: toMs(w.date), kg: w.kg }));
    const anchor = data.current.avg7Kg;
    const candidates = [toMs(today) + 60 * DAY_MS];
    if (cfg?.goalDate) candidates.push(toMs(cfg.goalDate));
    for (const p of data.projections) if (p.hitDate) candidates.push(toMs(p.hitDate));
    const endMs = Math.min(Math.max(...candidates), toMs(today) + 730 * DAY_MS);
    const todayMs = toMs(today);
    const target = cfg?.targetWeightKg ?? null;

    // One row per date shared by every series, so the tooltip shows the
    // values for that date: weigh-ins in the past, projections from today
    // on (a point each week, plus the goal date and the end).
    type Row = { t: number; kg?: number; post?: number; fit?: number; fit7?: number; postFit?: number; avg?: number } & Partial<Record<Projection["method"], number>>;
    const rows = new Map<number, Row>();
    for (const h of history) rows.set(h.t, { t: h.t, kg: h.kg });
    // Post-run weigh-ins (taken soon after a run), drawn in green.
    for (const w of data.postRunWeights ?? []) {
      const t = toMs(w.date);
      if (t < startMs) continue;
      const row = rows.get(t) ?? { t };
      row.post = w.kg;
      rows.set(t, row);
    }

    // The fitted trend line through the window's weigh-ins (where "Scale
    // trend" gets its rate), drawn back across the past dates it was fitted on.
    const fit = data.trendFit;
    if (fit) {
      const f0 = toMs(fit.startDate), f1 = toMs(fit.endDate);
      for (const ms of [f0, f1]) if (!rows.has(ms)) rows.set(ms, { t: ms });
      rows.forEach(r => {
        if (r.t >= f0 && r.t <= f1) r.fit = fit.startKg + (fit.endKg - fit.startKg) * ((r.t - f0) / (f1 - f0 || 1));
      });
    }
    // The line fitted through just the last 7 days.
    const fit7 = data.trendFit7;
    if (fit7) {
      const f0 = toMs(fit7.startDate), f1 = toMs(fit7.endDate);
      for (const ms of [f0, f1]) if (!rows.has(ms)) rows.set(ms, { t: ms });
      rows.forEach(r => {
        if (r.t >= f0 && r.t <= f1) r.fit7 = fit7.startKg + (fit7.endKg - fit7.startKg) * ((r.t - f0) / (f1 - f0 || 1));
      });
    }
    // The same for the line fitted through the post-run weigh-ins.
    const pfit = data.postRunFit;
    if (pfit) {
      const f0 = toMs(pfit.startDate), f1 = toMs(pfit.endDate);
      for (const ms of [f0, f1]) if (!rows.has(ms)) rows.set(ms, { t: ms });
      rows.forEach(r => {
        if (r.t >= f0 && r.t <= f1) r.postFit = pfit.startKg + (pfit.endKg - pfit.startKg) * ((r.t - f0) / (f1 - f0 || 1));
      });
    }
    const projTimes = new Set<number>([todayMs, endMs]);
    for (let ms = todayMs; ms < endMs; ms += 7 * DAY_MS) projTimes.add(ms);
    if (cfg?.goalDate && toMs(cfg.goalDate) > todayMs && toMs(cfg.goalDate) <= endMs) projTimes.add(toMs(cfg.goalDate));
    projTimes.forEach(ms => {
      const row = rows.get(ms) ?? { t: ms };
      const days = (ms - todayMs) / DAY_MS;
      for (const p of data.projections) {
        const from = p.anchorKg ?? anchor;
        let kg = from + (p.kgPerWeek / 7) * days;
        // A losing projection stops at the target once it gets there.
        if (target != null && p.kgPerWeek < 0 && from > target) kg = Math.max(kg, target);
        row[p.method] = kg;
      }
      rows.set(ms, row);
    });
    // The 7-day average held flat from today to the goal date (or the chart's
    // end): where you'd be if your weight didn't change.
    const avgEnd = cfg?.goalDate && toMs(cfg.goalDate) > todayMs ? Math.min(toMs(cfg.goalDate), endMs) : endMs;
    if (!rows.has(avgEnd)) rows.set(avgEnd, { t: avgEnd });
    rows.forEach(r => { if (r.t >= todayMs && r.t <= avgEnd) r.avg = anchor; });
    const points = Array.from(rows.values()).sort((a, b) => a.t - b.t);

    const ys = points.flatMap(r => [r.kg, r.post, r.fit, r.fit7, r.postFit, ...data.projections.map(p => r[p.method])]).filter((v): v is number => v != null);
    if (target != null) ys.push(target);
    const lo = Math.min(...ys), hi = Math.max(...ys);
    const pad = Math.max(0.5, (hi - lo) * 0.08);
    const domain: [number, number] = [lo - pad, hi + pad];

    // The weight where each projection crosses the goal-date line, and at the
    // end of the 7-day average (held flat), to dot and label. Labels are nudged
    // apart (about 22px minimum) so close values don't overprint each other.
    const goalMs = cfg?.goalDate ? toMs(cfg.goalDate) : null;
    const rawMarks: { key: string; ms: number; kg: number; color: string }[] = [];
    if (goalMs != null && goalMs > todayMs && goalMs <= endMs) {
      const days = (goalMs - todayMs) / DAY_MS;
      for (const p of data.projections) {
        const from = p.anchorKg ?? anchor;
        let kg = from + (p.kgPerWeek / 7) * days;
        if (target != null && p.kgPerWeek < 0 && from > target) kg = Math.max(kg, target);
        rawMarks.push({ key: p.method, ms: goalMs, kg, color: PROJ_COLORS[p.method] });
      }
    }
    if (avgEnd > todayMs) rawMarks.push({ key: "avg", ms: avgEnd, kg: anchor, color: "#fbbf24" });
    const pxPerKg = 250 / (domain[1] - domain[0]); // the plot is about 250px tall
    let lastPx = -Infinity;
    const endMarks = rawMarks.sort((a, b) => b.kg - a.kg).map(m => {
      const px = (domain[1] - m.kg) * pxPerKg;
      const at = Math.max(px, lastPx + 22);
      lastPx = at;
      return { ...m, dy: at - px };
    });
    const stoneTicks = unit === "st" ? halfStoneTicks(domain[0], domain[1]) : [];
    return {
      points, startMs: history[0]?.t ?? startMs, endMs, domain,
      anchor, avgFrom: todayMs - 6 * DAY_MS, todayMs, endMarks,
      ticks: stoneTicks.length > 0 ? stoneTicks : undefined,
    };
  }, [data, cfg, today]);

  // The days shown in the calories chart (all, or the zoomed span).
  const calDomain = calZoom.domain;
  const visibleDays = useMemo(() => {
    if (!data) return [];
    if (!calDomain) return data.days;
    const lo = Math.max(0, Math.round(calDomain[0]));
    const hi = Math.min(data.days.length - 1, Math.round(calDomain[1]));
    return data.days.slice(lo, hi + 1);
  }, [data, calDomain]);

  const wZoom = useChartZoom(weightChart?.startMs ?? 0, weightChart?.endMs ?? 0, 3 * DAY_MS);
  const wDomain = wZoom.domain;

  // Weight chart's y-axis refitted to the weights inside the zoomed span.
  const weightZoomY = useMemo(() => {
    if (!weightChart || !wDomain || !data) return null;
    const [l, r] = wDomain;
    const ys = weightChart.points
      .filter(p => p.t >= l && p.t <= r)
      .flatMap(p => [p.kg, p.post, p.fit, p.fit7, p.postFit, p.avg, ...data.projections.map(pr => p[pr.method])])
      .filter((v): v is number => v != null);
    if (ys.length === 0) return null;
    const lo = Math.min(...ys), hi = Math.max(...ys);
    const pad = Math.max(0.3, (hi - lo) * 0.12);
    const domain: [number, number] = [lo - pad, hi + pad];
    const ticks = unit === "st" ? halfStoneTicks(domain[0], domain[1]) : [];
    return { domain, ticks: ticks.length >= 2 ? ticks : undefined };
  }, [weightChart, wDomain, data, unit]);

  // "12st 9.5", "185.3 lb" or "84.1 kg": the weight written beside a goal-date dot.
  const weightShort = (kg: number) => {
    if (unit === "kg") return `${kg.toFixed(1)} kg`;
    const lb = kg * LB_PER_KG;
    if (unit === "lb") return `${lb.toFixed(1)} lb`;
    let st = Math.floor(lb / 14);
    let rest = lb - st * 14;
    if (Number(rest.toFixed(1)) >= 14) { st += 1; rest -= 14; }
    return `${st}st ${rest.toFixed(1)}`;
  };

  const weightTick = (kg: number) => {
    if (unit === "kg") return `${kg.toFixed(0)}`;
    const lb = kg * LB_PER_KG;
    if (unit === "lb") return `${lb.toFixed(0)}`;
    const total = Math.round(lb); // whole pounds first, so a whole stone reads "13st 0", never "12st 14"
    return `${Math.floor(total / 14)}st ${total % 14}`;
  };

  return (
    <div className="relative isolate min-h-screen flex flex-col text-slate-100">
      <div aria-hidden className="fixed inset-0 -z-10 bg-slate-950 bg-cover bg-center bg-no-repeat pointer-events-none"
        style={{ backgroundImage: "linear-gradient(rgba(2,6,23,0.85), rgba(2,6,23,0.85)), url('/dashboard-hero.png')" }} />
      <header className="border-b border-white/5 bg-slate-950/70 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-[100rem] mx-auto px-4 h-14 flex items-center justify-between gap-3">
          <Link href="/dashboard" className="text-sm text-slate-500 hover:text-slate-300 transition-colors">← Dashboard</Link>
          <span className="font-bold text-green-400 text-lg tracking-tight">🥗 Nutrition</span>
          <div className="flex items-center gap-3 min-w-0">
            {data && (() => {
              const s = data.sources;
              const next = loadedAt != null ? Math.max(0, Math.ceil((loadedAt + AUTO_REFRESH_MS - now) / 60_000)) : null;
              const nextWeight = new Date(now); // hourly Garmin weigh-in job runs at :37
              nextWeight.setMinutes(37, 0, 0);
              if (nextWeight.getTime() <= now) nextWeight.setHours(nextWeight.getHours() + 1);
              const detail = [
                `Page updated ${loadedAt ? stamp(new Date(loadedAt).toISOString()) : "-"}; next auto-refresh in ${next ?? "-"} min`,
                `Garmin weigh-ins fetched ${stamp(s.garminWeight)} (hourly at :37, next ${stamp(nextWeight.toISOString())}, and when this page opens)`,
                `Today's calories burnt from Garmin ${stamp(s.todayBurn)} (at most every 15 min)`,
                `Lose It! food from the phone ${stamp(s.food)} (phone checks every ~15 min)`,
                `GarminDB sync ${stamp(s.garminDb)} (daily 06:00 and after new activities)`,
              ].join("\n");
              return (
                <span className="hidden md:inline text-[11px] text-slate-500 truncate" title={detail}>
                  Updated {loadedAt ? stamp(new Date(loadedAt).toISOString()) : "-"}
                  {" · "}weight {stamp(s.garminWeight)}
                  {" · "}burn {stamp(s.todayBurn)}
                  {" · "}food {stamp(s.food)}
                  {" · "}GarminDB {stamp(s.garminDb)}
                  {" · "}next refresh {next ?? "-"}m
                </span>
              );
            })()}
            <Link href="/settings?tab=nutrition" className="text-xs text-slate-500 hover:text-slate-300 transition-colors shrink-0">Goals</Link>
          </div>
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
                value={formatWeight(data.current?.kg, unit, { exact: true })}
                sub={<>
                  {data.current
                    ? <>
                        <div>
                          {data.current.kg.toFixed(2)} kg · {data.current.measuredAt
                            ? new Date(data.current.measuredAt).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
                            : longDate(data.current.date)} · {data.current.source}
                          {data.current.postRun && <span className="text-emerald-400"> · post-run</span>}
                        </div>
                        <div className="text-slate-500">7-day avg {formatWeight(data.current.avg7Kg, unit)}</div>
                        {data.current.postRun && data.current.regularKg != null && (
                          <div className="text-slate-500">Morning {formatWeight(data.current.regularKg, unit)}</div>
                        )}
                      </>
                    : "No weigh-ins yet"}
                  {weightRefresh.msg && <div className="text-slate-500 mt-0.5">{weightRefresh.msg}</div>}
                </>}
                action={
                  <button
                    onClick={refreshWeight}
                    disabled={weightRefresh.busy}
                    title="Get the latest weight from Garmin"
                    aria-label="Get the latest weight from Garmin"
                    className="text-slate-500 hover:text-slate-200 disabled:opacity-60 transition-colors -m-1 p-1"
                  >
                    <svg viewBox="0 0 24 24" className={`h-4 w-4 ${weightRefresh.busy ? "animate-spin" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                      <path d="M21 3v6h-6" />
                    </svg>
                  </button>
                }
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
                sub={<>
                  <div>{todayRow?.net != null
                    ? <>net {todayRow.net > 0 ? "+" : "−"}{kcal(Math.abs(todayRow.net))} (burnt {kcal(todayRow.burnt)}{todayRow.partial ? " so far" : ""})</>
                    : "Garmin burn not in yet"}</div>
                  {cfg.dailyCalorieLimit != null
                    ? (() => {
                        const left = cfg.dailyCalorieLimit - (todayRow?.eaten ?? 0);
                        return left >= 0
                          ? <span className="text-emerald-300">{kcal(left)} left of {kcal(cfg.dailyCalorieLimit)}</span>
                          : <span className="text-rose-300">{kcal(-left)} over {kcal(cfg.dailyCalorieLimit)}</span>;
                      })()
                    : "No limit set"}
                </>}
              />
              {(() => {
                const avg = data.averages.deficit7 == null ? null : -data.averages.deficit7; // net = −deficit
                const lastFull = [...data.days].reverse().find(d => d.date < today && d.net != null);
                const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${kcal(Math.abs(n))}`;
                return (
                  <Stat
                    label="Avg net, eaten − burnt (7 days)"
                    value={avg == null ? "—" : `${signed(avg)} kcal`}
                    sub={avg == null
                      ? "Needs logged days with Garmin burn"
                      : <>
                          <span className={avg <= 0 ? "text-emerald-300" : "text-rose-300"}>{avg <= 0 ? "deficit" : "gain"}/day</span>
                          {" "}over {data.averages.deficit7Days} logged day{data.averages.deficit7Days === 1 ? "" : "s"}
                          {lastFull && <> · {shortDate(lastFull.date)}: {signed(lastFull.net!)}</>}
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
                <div className="flex items-center gap-1">
                  {calDomain
                    ? <button onClick={calZoom.reset}
                        className="text-xs px-2.5 py-1 mr-1 rounded-lg border border-sky-500/40 bg-sky-500/15 text-sky-300 hover:bg-sky-500/25 transition-colors">
                        Reset zoom
                      </button>
                    : <span className="hidden sm:inline text-[11px] text-slate-600 mr-2">scroll to zoom · drag to pan</span>}
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
              <div ref={calZoom.ref} className={`select-none ${calDomain ? "cursor-grab" : ""}`}>
              <ResponsiveContainer width="100%" height={320}>
                <ComposedChart data={visibleDays} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={1} barCategoryGap="20%">
                  <CartesianGrid strokeDasharray="3 3" stroke={C.grid} vertical={false} />
                  <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fill: C.axis, fontSize: 10 }} axisLine={{ stroke: C.grid }} tickLine={false} minTickGap={16} />
                  <YAxis tick={{ fill: C.axis, fontSize: 10 }} axisLine={false} tickLine={false} width={44}
                    domain={[(min: number) => Math.min(min, ...visibleDays.map(d => (d.eaten ?? 0) - (d.exercise ?? 0))), "auto"]} />
                  <Tooltip content={<CaloriesTooltip />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
                  <Legend
                    wrapperStyle={{ fontSize: 11, color: C.axis, cursor: "pointer" }}
                    onClick={e => toggleSeries(String((e as { dataKey?: unknown }).dataKey ?? ""))}
                    formatter={(value, entry) => (
                      <span style={{ opacity: hidden.has(String((entry as { dataKey?: unknown }).dataKey)) ? 0.35 : 1 }}>{value}</span>
                    )}
                  />
                  <Bar dataKey="eaten" name="Eaten" fill={C.eaten} radius={[2, 2, 0, 0]} hide={hidden.has("eaten")}
                    shape={(p: unknown) => <EatenBar {...(p as { x?: number; y?: number; width?: number; height?: number; payload?: DayRow })}
                      showTip={!hidden.has("exercise")} minKcal={cfg.minDailyCalories ?? 1400} />} />
                  <Bar dataKey="exercise" name="Exercise" fill={C.exercise} radius={[2, 2, 0, 0]} hide={hidden.has("exercise")} />
                  <Bar dataKey="burnt" name="Burnt" fill={C.burnt} radius={[2, 2, 0, 0]} hide={hidden.has("burnt")} />
                  <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" />
                  {/* Net (eaten − burnt) as a line: dots green on a deficit, red on a gain. */}
                  <Line dataKey="net" name="Net (eaten − burnt)" stroke={C.netLine} strokeWidth={2} connectNulls={false}
                    isAnimationActive={false} hide={hidden.has("net")}
                    dot={(p: { cx?: number; cy?: number; payload?: DayRow; index?: number }) => {
                      const v = p.payload?.net;
                      if (v == null || p.cx == null || p.cy == null) return <g key={p.index} />;
                      // Red on a gain, and on a day under the minimum eaten.
                      const red = v > 0 || underMinimum(p.payload, cfg.minDailyCalories ?? 1400);
                      return <circle key={p.index} cx={p.cx} cy={p.cy} r={p.payload?.partial ? 4 : 3.5}
                        fill={p.payload?.partial ? "transparent" : red ? C.netOver : C.netOk}
                        stroke={red ? C.netOver : C.netOk} strokeWidth={2} />;
                    }} />
                  {cfg.dailyCalorieLimit != null && (
                    <ReferenceLine y={cfg.dailyCalorieLimit} stroke={C.limit} strokeDasharray="6 4"
                      label={{ value: `Limit ${kcal(cfg.dailyCalorieLimit)}`, fill: C.limit, fontSize: 10, position: "insideTopRight" }} />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
              </div>
              <p className="text-xs text-slate-500 mt-2">
                Last {data.averages.windowDays} days (not counting today): avg eaten {kcal(data.averages.eaten)} kcal on{" "}
                {data.averages.loggedDays} logged days · avg burnt {kcal(data.averages.burnt)} · avg exercise {kcal(data.averages.exercise)} ·
                avg net {data.averages.net == null ? "—" : `${data.averages.net > 0 ? "+" : "−"}${kcal(Math.abs(data.averages.net))} kcal`}.
                The net line (eaten − burnt) dips below zero on a deficit (green dots) and rises above on a gain (red); today's hollow dot is "so far" and updates through the day. Click a legend entry to hide it.
                Days with nothing logged in Lose It! are left out of the eaten average.
                The white tip on each Eaten bar is as tall as that day&apos;s Exercise bar, so the amber below it is eaten − exercise (if you burnt more than you ate, the white reaches below zero).
                A red Eaten bar (with a slightly lighter red tip) and a red net dot mean less than {kcal(cfg.minDailyCalories ?? 1400)} kcal was eaten that day, the daily minimum; today stays red until it&apos;s reached.
              </p>
            </Card>

            <div className="grid grid-cols-1 gap-6">
              {/* Weight + projections chart */}
              <Card title="Weight and projections">
                {!weightChart ? (
                  <p className="text-sm text-slate-500">No weigh-ins yet.</p>
                ) : (
                  <div ref={wZoom.ref} className={`select-none ${wDomain ? "cursor-grab" : ""}`}>
                  <div className="flex justify-end mb-1 min-h-[1.5rem]">
                    {wDomain
                      ? <button onClick={wZoom.reset}
                          className="text-xs px-2.5 py-1 rounded-lg border border-sky-500/40 bg-sky-500/15 text-sky-300 hover:bg-sky-500/25 transition-colors">
                          Reset zoom
                        </button>
                      : <span className="text-[11px] text-slate-600">scroll to zoom · drag to pan</span>}
                  </div>
                  <ResponsiveContainer width="100%" height={320}>
                    <ComposedChart data={weightChart.points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                      <XAxis dataKey="t" type="number" scale="time" domain={wDomain ?? [weightChart.startMs, weightChart.endMs]} allowDataOverflow={!!wDomain}
                        tickFormatter={t => shortDate(msToYmd(t))} tick={{ fill: C.axis, fontSize: 10 }}
                        axisLine={{ stroke: C.grid }} tickLine={false} minTickGap={24} />
                      <YAxis type="number" orientation="right" domain={weightZoomY?.domain ?? weightChart.domain}
                        ticks={weightZoomY ? weightZoomY.ticks : weightChart.ticks} allowDataOverflow={!!weightZoomY} tickFormatter={weightTick}
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
                          label={{ value: "Goal date", fill: C.target, fontSize: 10, position: "insideTopRight" }} />
                      )}
                      <ReferenceLine x={toMs(today)} stroke="rgba(255,255,255,0.2)" />
                      {/* Weigh-ins as dots only (no connecting line) */}
                      <Line dataKey="kg" name="Weigh-ins" stroke={C.weight} strokeOpacity={0} legendType="circle" connectNulls={false}
                        dot={{ r: 3, fill: C.weight, stroke: "none" }} activeDot={{ r: 5, fill: C.weight, stroke: "none" }}
                        isAnimationActive={false} />
                      {/* Post-run weigh-ins (taken soon after a run), in green */}
                      <Line dataKey="post" name="Post-run weigh-ins" stroke={PROJ_COLORS.postrun} strokeOpacity={0} legendType="circle" connectNulls={false}
                        dot={{ r: 4, fill: PROJ_COLORS.postrun, stroke: "#052e16", strokeWidth: 1 }} activeDot={{ r: 5, fill: PROJ_COLORS.postrun, stroke: "none" }}
                        isAnimationActive={false} />
                      {data.postRunFit && (
                        <Line dataKey="postFit" name={`Post-run fit (last ${cfg.trendDays} days)`} stroke={PROJ_COLORS.postrun} strokeOpacity={0.55}
                          strokeWidth={2} connectNulls dot={false} activeDot={false} isAnimationActive={false} />
                      )}
                      {/* Fitted trend over the window's weigh-ins: the basis of "Scale trend" */}
                      {data.trendFit7 && (
                        <Line dataKey="fit7" name="Trend fit (last 7 weigh-ins)" stroke={PROJ_COLORS.trend7} strokeOpacity={0.55}
                          strokeWidth={2} connectNulls dot={false} activeDot={false} isAnimationActive={false} />
                      )}
                      {data.trendFit && (
                        <Line dataKey="fit" name={`Trend fit (last ${cfg.trendDays} days)`} stroke={PROJ_COLORS.trend} strokeOpacity={0.55}
                          strokeWidth={2} connectNulls dot={false} activeDot={false} isAnimationActive={false} />
                      )}
                      {/* The 7-day average, held flat to the goal date (no change) */}
                      <Line dataKey="avg" name="7-day avg (if unchanged)" stroke="#fbbf24" strokeOpacity={0.8} strokeWidth={2}
                        strokeDasharray="2 5" connectNulls dot={false} activeDot={false} isAnimationActive={false} />
                      {/* The 7-day average every projection starts from */}
                      <ReferenceLine segment={[{ x: weightChart.avgFrom, y: weightChart.anchor }, { x: weightChart.todayMs, y: weightChart.anchor }]}
                        stroke="#fbbf24" strokeWidth={4} ifOverflow={wDomain ? "hidden" : "extendDomain"}
                        label={{ value: "7-day avg", fill: "#fbbf24", fontSize: 10, position: "insideBottomLeft" }} />
                      {data.projections.map(p => (
                        <Line key={p.method} dataKey={p.method} name={p.label} stroke={PROJ_COLORS[p.method]} connectNulls
                          strokeWidth={2} strokeDasharray="5 4" dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
                      ))}
                      {/* Each projection's weight where it meets the goal date, and the 7-day average's weight at its end */}
                      {weightChart.endMarks.filter(m => !wDomain || (m.ms >= wDomain[0] && m.ms <= wDomain[1])).map(m => (
                        <ReferenceDot key={`end-${m.key}`} x={m.ms} y={m.kg} r={4}
                          fill={m.color} stroke="#f8fafc" strokeWidth={1.5} ifOverflow={wDomain ? "hidden" : "extendDomain"}
                          label={{
                            content: props => {
                              const vb = (props as { viewBox?: { x: number; y: number; width: number; height: number } }).viewBox;
                              if (!vb) return null;
                              // White text on a dark pill edged in the line's colour, so it
                              // reads over the dashed line and gridlines behind it.
                              const text = weightShort(m.kg);
                              const w = text.length * 7 + 14;
                              const cy = vb.y + vb.height / 2 + m.dy;
                              const right = vb.x - 8;
                              return (
                                <g>
                                  <rect x={right - w} y={cy - 9} width={w} height={18} rx={4}
                                    fill="#0f172a" fillOpacity={0.94} stroke={m.color} strokeWidth={1.5} />
                                  <text x={right - w / 2} y={cy + 4.5} textAnchor="middle" fill="#f8fafc" fontSize={12} fontWeight={700}>
                                    {text}
                                  </text>
                                </g>
                              );
                            },
                          }} />
                      ))}
                    </ComposedChart>
                  </ResponsiveContainer>
                  </div>
                )}
                {weightChart && (
                  <p className="text-xs text-slate-500 mt-2">
                    How the projections are made: the faint purple line is the straight line fitted through your weigh-ins over the last {cfg.trendDays} days;
                    its slope is the Scale trend rate. The rose line does the same through just your last 7 weigh-ins (post-run ones aren't counted), however many days that spans: a more immediate, but noisier, read. The Scale trend continues from where that purple line is today, so it joins it without a jump. The calorie projections start from your 7-day average weight (yellow bar), not a single weigh-in,
                    so one heavy or light day doesn&apos;t swing them. A weigh-in taken within 3 hours after a run finished (from your Garmin activities) is taken as post-run: those are the green dots, left out of everything above and given their own green fitted line and "Post-run trend" projection, which starts from where that line is today; the dotted yellow line carries that average flat to the goal date, i.e. no change. Sticking to your limit uses calories instead: your {cfg.dailyCalorieLimit ?? "—"} kcal
                    limit against your average Garmin burn.
                  </p>
                )}
              </Card>

              {/* Projection table */}
              <Card title="Projections">
                {data.projections.length === 0 ? (
                  <p className="text-sm text-slate-500">Not enough data yet. Projections need a few weigh-ins or logged days.</p>
                ) : (
                  <div className="space-y-3">
                    <div className="flex flex-col md:flex-row gap-3">
                    {data.projections.map(p => (
                      <div key={p.method} className="flex-1 min-w-0 rounded-lg border border-white/10 bg-slate-800/40 p-3">
                        <div className="flex items-center gap-2">
                          <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: PROJ_COLORS[p.method] }} />
                          <span className="text-sm font-medium text-slate-200">{p.label}</span>
                          <span className="ml-auto text-xs text-slate-400 tabular-nums">{formatWeightDelta(p.kgPerWeek, unit)}/wk</span>
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5">{p.basis}</div>
                        {p.capped && (
                          <div className="text-xs text-amber-300 mt-0.5">
                            Measured {formatWeightDelta(p.rawKgPerWeek, unit)}/wk; dates assume the 2 lb/wk maximum.
                          </div>
                        )}
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
                    </div>
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
