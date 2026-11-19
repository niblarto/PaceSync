"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

// Landscape popup for one night on the Health page: the sleep stages (a hypnogram) with the overnight HRV and heart
// rate lined up underneath on the same time axis. Data from /api/health/night.

interface Night {
  date: string; start: number; end: number;
  stages: { start: number; end: number; stage: "deep" | "light" | "rem" | "awake" }[];
  hrv: { t: number; v: number }[]; heartRate: { t: number; v: number }[];
  avgHrv: number | null; score: number | null;
}

const ROWS = ["awake", "rem", "light", "deep"] as const; // top → bottom
const LABEL: Record<string, string> = { awake: "Awake", rem: "REM", light: "Light", deep: "Deep" };
const COL: Record<string, string> = { awake: "#f472b6", rem: "#a855f7", light: "#38bdf8", deep: "#4f46e5" };
const HRV = "#fbbf24", HR = "#fb7185";

const clock = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const longDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
const dur = (ms: number) => `${Math.floor(ms / 3_600_000)}h ${String(Math.round((ms % 3_600_000) / 60_000)).padStart(2, "0")}m`;

// Chart geometry (viewBox units)
const W = 1100, L = 62, R = 44, T = 14;
const H1 = 190;            // stage panel height
const GAP = 34;
const H2 = 170;            // HRV / HR panel height
const AX = 26;             // time axis
const VH = T + H1 + GAP + H2 + AX + 8;

export function SleepTimelineModal({ date, onClose }: { date: string; onClose: () => void }) {
  const [night, setNight] = useState<Night | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null); // epoch ms under the pointer
  const [showHr, setShowHr] = useState(true);

  useEffect(() => {
    let live = true;
    setNight(null); setError(null);
    fetch(`/api/health/night?date=${date}`)
      .then(async r => { const b = await r.json(); if (!r.ok) throw new Error(b.error || `Failed (${r.status})`); return b as Night; })
      .then(n => { if (live) setNight(n); })
      .catch(e => { if (live) setError(e instanceof Error ? e.message : "Couldn't load that night"); });
    return () => { live = false; };
  }, [date]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const geo = useMemo(() => {
    if (!night) return null;
    const span = Math.max(1, night.end - night.start);
    const x = (t: number) => L + ((t - night.start) / span) * (W - L - R);
    const inv = (px: number) => night.start + ((px - L) / (W - L - R)) * span;
    const rowH = H1 / 4;
    const rowY = (s: string) => T + ROWS.indexOf(s as typeof ROWS[number]) * rowH;
    // HRV axis
    const hv = night.hrv.map(p => p.v);
    const hMin = hv.length ? Math.floor(Math.min(...hv) - 6) : 0, hMax = hv.length ? Math.ceil(Math.max(...hv) + 6) : 100;
    const y2 = T + H1 + GAP;
    const hy = (v: number) => y2 + H2 - ((v - hMin) / Math.max(1, hMax - hMin)) * H2;
    // HR axis
    const rv = night.heartRate.map(p => p.v);
    const rMin = rv.length ? Math.floor(Math.min(...rv) - 3) : 0, rMax = rv.length ? Math.ceil(Math.max(...rv) + 3) : 100;
    const ry = (v: number) => y2 + H2 - ((v - rMin) / Math.max(1, rMax - rMin)) * H2;
    // hourly ticks (local time)
    const ticks: number[] = [];
    const first = new Date(night.start); first.setMinutes(0, 0, 0);
    for (let t = first.getTime() + 3_600_000; t < night.end; t += 3_600_000) ticks.push(t);
    return { span, x, inv, rowH, rowY, hMin, hMax, hy, rMin, rMax, ry, y2, ticks };
  }, [night]);

  const at = useMemo(() => {
    if (!night || hover == null) return null;
    const st = night.stages.find(s => hover >= s.start && hover < s.end) ?? null;
    const nearest = <T extends { t: number }>(a: T[], within: number) => {
      let best: T | null = null;
      for (const p of a) if (Math.abs(p.t - hover) <= within && (!best || Math.abs(p.t - hover) < Math.abs(best.t - hover))) best = p;
      return best;
    };
    return { stage: st, hrv: nearest(night.hrv, 3 * 60_000), hr: nearest(night.heartRate, 3 * 60_000) };
  }, [night, hover]);

  const totals = useMemo(() => {
    const t: Record<string, number> = { deep: 0, light: 0, rem: 0, awake: 0 };
    night?.stages.forEach(s => { t[s.stage] += s.end - s.start; });
    return t;
  }, [night]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={onClose}>
      <div role="dialog" aria-label="Sleep timeline" onClick={e => e.stopPropagation()}
        className="w-full max-w-[1250px] max-h-[95vh] overflow-y-auto rounded-xl border border-white/10 bg-slate-900 shadow-2xl p-5">
        <div className="flex items-start justify-between gap-4 mb-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-100">🌙 Night ending {longDate(date)}</h3>
            {night && (
              <p className="text-xs text-slate-400 mt-0.5">
                {clock(night.start)} → {clock(night.end)} · {dur(night.end - night.start)} in bed
                {night.score != null && <> · score {night.score}</>}
                {night.avgHrv != null && <> · avg HRV <span style={{ color: HRV }}>{Math.round(night.avgHrv)} ms</span></>}
              </p>
            )}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer">
              <input type="checkbox" checked={showHr} onChange={e => setShowHr(e.target.checked)} /> Heart rate
            </label>
            <button onClick={onClose} className="rounded-lg border border-white/10 bg-slate-800/60 hover:bg-slate-700/60 text-slate-300 text-xs px-2.5 py-1">✕ Close</button>
          </div>
        </div>

        {error && <p className="text-sm text-rose-300 py-10 text-center">{error}</p>}
        {!night && !error && <p className="text-sm text-slate-500 py-10 text-center">Loading…</p>}

        {night && geo && (
          <>
            <svg viewBox={`0 0 ${W} ${VH}`} className="w-full select-none" style={{ aspectRatio: `${W} / ${VH}` }}
              onMouseLeave={() => setHover(null)}
              onMouseMove={e => {
                const r = e.currentTarget.getBoundingClientRect();
                const px = ((e.clientX - r.left) / r.width) * W;
                setHover(px >= L && px <= W - R ? geo.inv(px) : null);
              }}>
              {/* stage rows */}
              {ROWS.map(s => (
                <g key={s}>
                  <rect x={L} y={geo.rowY(s)} width={W - L - R} height={geo.rowH} fill={s === "light" || s === "awake" ? "rgba(255,255,255,0.025)" : "rgba(255,255,255,0.045)"} />
                  <text x={L - 8} y={geo.rowY(s) + geo.rowH / 2 + 4} textAnchor="end" fontSize="11" fill="#94a3b8">{LABEL[s]}</text>
                </g>
              ))}
              {/* hour gridlines */}
              {geo.ticks.map(t => (
                <line key={t} x1={geo.x(t)} x2={geo.x(t)} y1={T} y2={T + H1 + GAP + H2} stroke="rgba(255,255,255,0.07)" />
              ))}
              {/* stage blocks, joined by thin connectors like a hypnogram */}
              {night.stages.map((s, i) => (
                <rect key={i} x={geo.x(s.start)} y={geo.rowY(s.stage) + 5} width={Math.max(1.2, geo.x(s.end) - geo.x(s.start))} height={geo.rowH - 10}
                  fill={COL[s.stage]} opacity={at?.stage === s ? 1 : 0.85} rx="2" />
              ))}

              {/* HRV panel */}
              <rect x={L} y={geo.y2} width={W - L - R} height={H2} fill="rgba(255,255,255,0.03)" />
              {[0, 0.5, 1].map(f => {
                const v = geo.hMin + (geo.hMax - geo.hMin) * f;
                return (
                  <g key={f}>
                    <line x1={L} x2={W - R} y1={geo.hy(v)} y2={geo.hy(v)} stroke="rgba(255,255,255,0.06)" />
                    <text x={L - 8} y={geo.hy(v) + 4} textAnchor="end" fontSize="10" fill={HRV}>{Math.round(v)}</text>
                  </g>
                );
              })}
              <text x={L - 8} y={geo.y2 - 6} textAnchor="end" fontSize="10" fill={HRV}>HRV ms</text>
              {night.hrv.length > 1 && (
                <polyline fill="none" stroke={HRV} strokeWidth="2" strokeLinejoin="round"
                  points={night.hrv.map(p => `${geo.x(p.t).toFixed(1)},${geo.hy(p.v).toFixed(1)}`).join(" ")} />
              )}
              {night.hrv.map(p => <circle key={p.t} cx={geo.x(p.t)} cy={geo.hy(p.v)} r="2.2" fill={HRV} />)}
              {showHr && night.heartRate.length > 1 && (
                <>
                  <polyline fill="none" stroke={HR} strokeWidth="1.5" opacity="0.8" strokeLinejoin="round"
                    points={night.heartRate.map(p => `${geo.x(p.t).toFixed(1)},${geo.ry(p.v).toFixed(1)}`).join(" ")} />
                  {[0, 1].map(f => {
                    const v = geo.rMin + (geo.rMax - geo.rMin) * f;
                    return <text key={f} x={W - R + 6} y={geo.ry(v) + 4} fontSize="10" fill={HR}>{Math.round(v)}</text>;
                  })}
                  <text x={W - R + 6} y={geo.y2 - 6} fontSize="10" fill={HR}>bpm</text>
                </>
              )}
              {night.hrv.length === 0 && (
                <text x={(L + W - R) / 2} y={geo.y2 + H2 / 2} textAnchor="middle" fontSize="12" fill="#64748b">No overnight HRV readings for this night</text>
              )}

              {/* time axis */}
              {geo.ticks.map(t => (
                <text key={t} x={geo.x(t)} y={T + H1 + GAP + H2 + 16} textAnchor="middle" fontSize="10" fill="#94a3b8">{clock(t)}</text>
              ))}
              <text x={L} y={T + H1 + GAP + H2 + 16} textAnchor="start" fontSize="10" fill="#e2e8f0">{clock(night.start)}</text>
              <text x={W - R} y={T + H1 + GAP + H2 + 16} textAnchor="end" fontSize="10" fill="#e2e8f0">{clock(night.end)}</text>

              {/* crosshair */}
              {hover != null && (
                <line x1={geo.x(hover)} x2={geo.x(hover)} y1={T} y2={T + H1 + GAP + H2} stroke="#e2e8f0" strokeOpacity="0.6" strokeDasharray="3 3" />
              )}
            </svg>

            {/* readout under the chart: follows the pointer */}
            <div className="mt-1 h-5 text-xs text-slate-300">
              {hover != null && at ? (
                <>
                  <span className="text-slate-100 font-medium">{clock(hover)}</span>
                  {at.stage && <> · <span style={{ color: COL[at.stage.stage] }}>{LABEL[at.stage.stage]}</span> <span className="text-slate-500">({dur(at.stage.end - at.stage.start)})</span></>}
                  {at.hrv && <> · HRV <span style={{ color: HRV }}>{Math.round(at.hrv.v)} ms</span></>}
                  {showHr && at.hr && <> · HR <span style={{ color: HR }}>{Math.round(at.hr.v)} bpm</span></>}
                </>
              ) : <span className="text-slate-600">Move over the chart to read off a time</span>}
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-slate-400">
              {ROWS.slice().reverse().map(s => (
                <span key={s} className="flex items-center gap-1.5">
                  <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: COL[s] }} />
                  {LABEL[s]} {dur(totals[s])}
                </span>
              ))}
              <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-4" style={{ background: HRV }} />HRV</span>
              {showHr && <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-4" style={{ background: HR }} />Heart rate</span>}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
