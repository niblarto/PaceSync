"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from "recharts";

interface ActivityDetail {
  activity_id: string;
  name: string;
  sport: string;
  sub_sport: string | null;
  start_time: string;
  stop_time: string | null;
  elapsed_time: string | null;
  moving_time: string | null;
  distance: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  calories: number | null;
  avg_speed: number | null;
  max_speed: number | null;
  ascent: number | null;
  descent: number | null;
  training_load: number | null;
  training_effect: number | null;
  anaerobic_training_effect: number | null;
  hrz_1_time: string | null;
  hrz_2_time: string | null;
  hrz_3_time: string | null;
  hrz_4_time: string | null;
  hrz_5_time: string | null;
}

interface LapRow {
  lap: number;
  start_time: string;
  elapsed_time: string | null;
  moving_time: string | null;
  distance: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  avg_cadence: number | null;
  avg_speed: number | null;
  ascent: number | null;
  calories: number | null;
  hrz_1_time: string | null;
  hrz_2_time: string | null;
  hrz_3_time: string | null;
  hrz_4_time: string | null;
  hrz_5_time: string | null;
}

interface StepsData {
  steps: number | null;
  avg_pace: string | null;
  avg_moving_pace: string | null;
  max_pace: string | null;
  avg_steps_per_min: number | null;
  avg_step_length: number | null;
  vo2_max: number | null;
}

interface ChartPoint {
  t: number;
  pace: number | null;
  cadence: number | null;
  hr: number | null;
}

interface ActivityData {
  activity: ActivityDetail;
  laps: LapRow[];
  steps: StepsData | null;
  records: ChartPoint[];
  recordsT0: string | null;
}

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
  const sec = Math.round(secs % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

// Pace stored as "HH:MM:SS.us" in steps_activities
function fmtPaceStr(s: string | null): string {
  if (!s) return "—";
  const secs = parseDuration(s);
  if (!secs) return "—";
  const m = Math.floor(secs / 60);
  const sec = Math.round(secs % 60);
  return `${m}:${sec.toString().padStart(2, "0")} /mi`;
}

// Format pace in seconds/mile as "M:SS"
function fmtPaceSecs(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function fmtDist(miles: number | null): string {
  if (!miles || miles < 0.01) return "—";
  return `${miles.toFixed(2)} mi`;
}

function fmtDateTime(ts: string): string {
  if (!ts) return "—";
  const d = new Date(ts.slice(0, 19).replace(" ", "T"));
  if (isNaN(d.getTime())) return ts.slice(0, 16);
  return d.toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short",
    year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function fmtDate(ts: string): string {
  if (!ts) return "—";
  const d = new Date(ts.slice(0, 19).replace(" ", "T"));
  if (isNaN(d.getTime())) return ts.slice(0, 10);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

// Format elapsed seconds as "M:SS" for chart X axis
function fmtTimeTick(secs: number): string {
  const m = Math.floor(secs / 60);
  return `${m}m`;
}

const ZONE_COLORS = [
  "bg-emerald-500",
  "bg-green-500",
  "bg-yellow-500",
  "bg-orange-500",
  "bg-red-500",
];
const ZONE_NAMES = ["Zone 1", "Zone 2", "Zone 3", "Zone 4", "Zone 5"];

const CARD = "rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5";
const TH = "text-left text-xs font-medium text-slate-500 uppercase tracking-wider pb-2";
const TD = "py-1.5 text-sm text-slate-300";

// Map a pace (secs/mile) to a colour on a green→yellow→orange scale
// using the activity-wide min/max so all laps share the same reference.
function paceToColor(pace: number | null, minPace: number, maxPace: number): string {
  if (pace === null) return "rgba(255,255,255,0.06)";
  const t = Math.max(0, Math.min(1, (pace - minPace) / (Math.max(maxPace - minPace, 1))));
  const hue = Math.round(142 - 117 * t); // 142 = green, 25 = orange
  return `hsl(${hue},65%,46%)`;
}

// Custom tooltip for pace/cadence chart
function ChartTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: number;
}) {
  if (!active || !payload?.length || label === undefined) return null;
  const m = Math.floor(label / 60);
  const s = label % 60;
  return (
    <div className="bg-slate-950 border border-white/10 rounded-lg p-2.5 text-xs space-y-1 shadow-xl">
      <p className="text-slate-400 font-medium mb-1">{m}:{s.toString().padStart(2, "0")}</p>
      {payload.map(p => (
        <p key={p.name} style={{ color: p.color }}>
          {p.name === "Pace"
            ? `${fmtPaceSecs(p.value)} /mi`
            : `${p.value} SPM`}
        </p>
      ))}
    </div>
  );
}

export function GarminActivityClient({ id }: { id: string }) {
  const [data, setData] = useState<ActivityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/garmin/activity/${id}`)
      .then(r => r.json())
      .then((d: ActivityData & { error?: string }) => {
        if (d.error) { setError(d.error); return; }
        setData(d);
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [id]);

  const a = data?.activity;

  // HR zone times and total for the bar chart
  const zoneTimes = a ? [
    parseDuration(a.hrz_1_time) ?? 0,
    parseDuration(a.hrz_2_time) ?? 0,
    parseDuration(a.hrz_3_time) ?? 0,
    parseDuration(a.hrz_4_time) ?? 0,
    parseDuration(a.hrz_5_time) ?? 0,
  ] : [];
  const zoneTotal = zoneTimes.reduce((s, v) => s + v, 0);
  const hasZones = zoneTotal > 0;

  const hasChart = (data?.records?.length ?? 0) > 0;

  // Compute pace domain: padded around the actual range so fast/slow sections
  // are visually distinct. Reversed so faster pace is at the top.
  const paceDomain = (() => {
    if (!hasChart) return [300, 720] as [number, number];
    const paces = (data?.records ?? []).map(r => r.pace).filter((p): p is number => p !== null);
    if (!paces.length) return [300, 720] as [number, number];
    const min = Math.min(...paces);
    const max = Math.max(...paces);
    const pad = (max - min) * 0.1;
    return [Math.max(180, Math.floor(min - pad)), Math.ceil(max + pad)] as [number, number];
  })();

  return (
    <div
      className="min-h-screen flex flex-col bg-cover bg-fixed bg-center bg-no-repeat"
      style={{ backgroundImage: "linear-gradient(rgba(2,6,23,0.65), rgba(2,6,23,0.65)), url('/dashboard-hero.png')" }}
    >
      <header className="border-b border-white/5 bg-slate-950/70 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 h-14 flex items-center justify-between">
          <Link href="/garmin" className="text-sm text-slate-500 hover:text-slate-300 transition-colors">
            ← Garmin Stats
          </Link>
          <span className="font-bold text-green-400 text-lg tracking-tight">Activity</span>
          <div />
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-4 py-8 flex-1 w-full space-y-5">
        {loading && <div className="text-slate-500 text-sm">Loading…</div>}
        {error && (
          <div className="rounded-xl bg-red-950/50 border border-red-800/50 p-4 text-red-400 text-sm">{error}</div>
        )}

        {a && (
          <>
            {/* Title */}
            <div>
              <p className="text-xs text-slate-500 mb-1">{fmtDateTime(a.start_time)}</p>
              <h1 className="text-xl font-semibold text-slate-100">{a.name || "Activity"}</h1>
              <p className="text-sm text-slate-500 capitalize mt-0.5">{a.sub_sport || a.sport}</p>
            </div>

            {/* Key stats */}
            <div className={CARD}>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-5">
                <Stat label="Distance" value={fmtDist(a.distance)} />
                <Stat label="Time" value={fmtDuration(a.elapsed_time)} />
                <Stat label="Avg pace" value={fmtPaceStr(data?.steps?.avg_pace ?? null)} />
                <Stat label="Best pace" value={fmtPaceStr(data?.steps?.max_pace ?? null)} />
                <Stat label="Avg HR" value={a.avg_hr ? `${a.avg_hr} bpm` : "—"} />
                <Stat label="Max HR" value={a.max_hr ? `${a.max_hr} bpm` : "—"} />
                <Stat label="Calories" value={a.calories?.toLocaleString() ?? "—"} />
                <Stat label="Steps" value={data?.steps?.steps?.toLocaleString() ?? "—"} />
                <Stat label="Ascent" value={a.ascent ? `${Math.round(a.ascent)} ft` : "—"} />
                <Stat label="Descent" value={a.descent ? `${Math.round(a.descent)} ft` : "—"} />
                <Stat label="VO₂ max" value={data?.steps?.vo2_max ? `${data.steps.vo2_max}` : "—"} />
                <Stat
                  label="Training effect"
                  value={a.training_effect ? `${a.training_effect.toFixed(1)}` : "—"}
                />
              </div>
            </div>

            {/* Pace & Cadence chart */}
            {hasChart && (
              <div className={CARD}>
                <h2 className="font-semibold text-sm text-slate-300 mb-1">Pace & Cadence</h2>
                <p className="text-xs text-slate-500 mb-4">
                  10-second averages — faster pace at top, cadence on right axis
                </p>
                <ResponsiveContainer width="100%" height={260}>
                  <ComposedChart
                    data={data!.records}
                    margin={{ top: 4, right: 52, left: 4, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />

                    {/* X: elapsed time */}
                    <XAxis
                      dataKey="t"
                      type="number"
                      scale="linear"
                      domain={["dataMin", "dataMax"]}
                      tickFormatter={fmtTimeTick}
                      tick={{ fill: "#64748b", fontSize: 10 }}
                      axisLine={{ stroke: "rgba(255,255,255,0.06)" }}
                      tickLine={false}
                      interval="preserveStartEnd"
                      tickCount={8}
                    />

                    {/* Left Y: pace (reversed → faster at top) */}
                    <YAxis
                      yAxisId="pace"
                      orientation="left"
                      reversed
                      domain={paceDomain}
                      tickFormatter={fmtPaceSecs}
                      tick={{ fill: "#34d399", fontSize: 10 }}
                      axisLine={false}
                      tickLine={false}
                      width={36}
                    />

                    {/* Right Y: cadence SPM */}
                    <YAxis
                      yAxisId="cadence"
                      orientation="right"
                      domain={[130, "auto"]}
                      tick={{ fill: "#fb923c", fontSize: 10 }}
                      axisLine={false}
                      tickLine={false}
                      width={36}
                    />

                    <Tooltip content={<ChartTooltip />} />

                    <Line
                      yAxisId="pace"
                      type="monotone"
                      dataKey="pace"
                      name="Pace"
                      stroke="#34d399"
                      strokeWidth={1.5}
                      dot={false}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                    <Line
                      yAxisId="cadence"
                      type="monotone"
                      dataKey="cadence"
                      name="Cadence"
                      stroke="#fb923c"
                      strokeWidth={1.5}
                      dot={false}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>

                <div className="flex gap-6 mt-3 text-xs text-slate-500">
                  <span className="flex items-center gap-1.5">
                    <span className="w-4 h-0.5 bg-emerald-400 inline-block rounded" />
                    Pace /mi
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-4 h-0.5 bg-orange-400 inline-block rounded" />
                    Cadence (SPM)
                  </span>
                </div>
              </div>
            )}

            {/* HR zone bar */}
            {hasZones && (
              <div className={CARD}>
                <h2 className="font-semibold text-sm text-slate-300 mb-4">Heart Rate Zones</h2>
                <div className="flex h-6 rounded-lg overflow-hidden gap-0.5">
                  {zoneTimes.map((t, i) => {
                    const pct = zoneTotal > 0 ? (t / zoneTotal) * 100 : 0;
                    if (pct < 0.5) return null;
                    return (
                      <div
                        key={i}
                        className={`${ZONE_COLORS[i]} transition-all`}
                        style={{ width: `${pct}%` }}
                        title={`${ZONE_NAMES[i]}: ${fmtDuration(t)}`}
                      />
                    );
                  })}
                </div>
                <div className="flex gap-4 mt-3 flex-wrap">
                  {zoneTimes.map((t, i) => (
                    <div key={i} className="flex items-center gap-1.5 text-xs text-slate-400">
                      <span className={`w-2.5 h-2.5 rounded-sm ${ZONE_COLORS[i]}`} />
                      <span>{ZONE_NAMES[i]}</span>
                      <span className="text-slate-500">{fmtDuration(t) || "—"}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Laps */}
            {data.laps.length > 0 && (() => {
              const hasTraditional = data.laps.some(l =>
                (l.distance && l.distance > 0) ||
                (parseDuration(l.elapsed_time) ?? 0) > 0
              );
              const hasLapZones = data.laps.some(l =>
                (parseDuration(l.hrz_1_time) ?? 0) + (parseDuration(l.hrz_2_time) ?? 0) +
                (parseDuration(l.hrz_3_time) ?? 0) + (parseDuration(l.hrz_4_time) ?? 0) +
                (parseDuration(l.hrz_5_time) ?? 0) > 0
              );

              // records[].t is elapsed seconds from the first record's timestamp, not a.start_time
              const refTs = data.recordsT0 ?? a.start_time;
              const refMs = new Date(refTs.replace(" ", "T")).getTime();

              const hasUsableSegments = hasChart && data.laps.some(lap => {
                const lapOffset = lap.start_time
                  ? (new Date(lap.start_time.replace(" ", "T")).getTime() - refMs) / 1000
                  : 0;
                const lapDur = parseDuration(lap.elapsed_time) ?? parseDuration(lap.moving_time) ?? 0;
                return lapOffset > 0 || lapDur > 0;
              });

              if (!hasUsableSegments && !hasTraditional && !hasLapZones) return null;

              // Global pace range for consistent colour scale across all laps
              const allPaces = data.records.filter(r => r.pace !== null).map(r => r.pace!);
              const globalMin = allPaces.length ? Math.min(...allPaces) : 300;
              const globalMax = allPaces.length ? Math.max(...allPaces) : 720;

              return (
                <div className={CARD}>
                  <h2 className="font-semibold text-sm text-slate-300 mb-4">Laps</h2>

                  {hasUsableSegments ? (
                    // Per-lap speed segments: each lap divided into 12 time-equal slices coloured by pace
                    <div className="space-y-2">
                      {data.laps.map(lap => {
                        const lapOffset = lap.start_time
                          ? (new Date(lap.start_time.replace(" ", "T")).getTime() - refMs) / 1000
                          : 0;
                        const lapDur = parseDuration(lap.elapsed_time) ?? parseDuration(lap.moving_time) ?? 0;
                        if (lapDur <= 0) return null;
                        const lapRecs = data.records.filter(
                          r => r.t >= lapOffset && r.t < lapOffset + lapDur + 5 && r.pace !== null
                        );

                        const N = 12;
                        const segLen = lapDur / N;
                        const segments = Array.from({ length: N }, (_, i) => {
                          const s0 = lapOffset + i * segLen;
                          const s1 = s0 + segLen;
                          const recs = lapRecs.filter(r => r.t >= s0 && r.t < s1);
                          return recs.length ? recs.reduce((s, r) => s + r.pace!, 0) / recs.length : null;
                        });

                        const validPaces = segments.filter((p): p is number => p !== null);
                        const avgPace = validPaces.length
                          ? validPaces.reduce((s, v) => s + v, 0) / validPaces.length
                          : null;

                        return (
                          <div key={lap.lap} className="flex items-center gap-3">
                            <span className="text-xs text-slate-500 w-10 shrink-0 text-right">
                              {lap.lap === 0 ? "Warm" : `Lap ${lap.lap}`}
                            </span>
                            <div className="flex h-5 flex-1 rounded overflow-hidden gap-px">
                              {segments.map((pace, i) => (
                                <div
                                  key={i}
                                  className="flex-1"
                                  style={{ backgroundColor: paceToColor(pace, globalMin, globalMax) }}
                                  title={pace !== null ? `${fmtPaceSecs(pace)} /mi` : "no data"}
                                />
                              ))}
                            </div>
                            <span className="text-xs text-slate-400 w-16 shrink-0 tabular-nums text-right">
                              {avgPace !== null ? `${fmtPaceSecs(avgPace)} /mi` : "—"}
                            </span>
                          </div>
                        );
                      })}
                      {/* Legend: gradient bar showing pace scale */}
                      <div className="flex items-center gap-2 mt-3 text-xs text-slate-600">
                        <span>{fmtPaceSecs(globalMin)}</span>
                        <div
                          className="flex-1 h-1.5 rounded"
                          style={{
                            background: `linear-gradient(to right, hsl(142,65%,46%), hsl(84,65%,46%), hsl(25,65%,46%))`,
                          }}
                        />
                        <span>{fmtPaceSecs(globalMax)}</span>
                      </div>
                    </div>
                  ) : hasTraditional ? (
                    <div className="overflow-x-auto">
                      <table className="w-full">
                        <thead>
                          <tr>
                            <th className={TH}>Lap</th>
                            <th className={TH}>Distance</th>
                            <th className={TH}>Time</th>
                            <th className={TH}>Avg HR</th>
                            <th className={TH}>Cadence</th>
                            <th className={TH}>Ascent</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/50">
                          {data.laps.map(lap => (
                            <tr key={lap.lap}>
                              <td className={`${TD} text-slate-500`}>{lap.lap}</td>
                              <td className={TD}>{fmtDist(lap.distance)}</td>
                              <td className={TD}>{fmtDuration(lap.elapsed_time)}</td>
                              <td className={TD}>{lap.avg_hr ? `${lap.avg_hr} bpm` : "—"}</td>
                              <td className={TD}>{lap.avg_cadence ? `${lap.avg_cadence * 2} spm` : "—"}</td>
                              <td className={TD}>{lap.ascent ? `${Math.round(lap.ascent)} ft` : "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : hasLapZones ? (
                    // Zone-only fallback (older activities without per-second records)
                    <div className="space-y-3">
                      {data.laps.map(lap => {
                        const times = [
                          parseDuration(lap.hrz_1_time) ?? 0,
                          parseDuration(lap.hrz_2_time) ?? 0,
                          parseDuration(lap.hrz_3_time) ?? 0,
                          parseDuration(lap.hrz_4_time) ?? 0,
                          parseDuration(lap.hrz_5_time) ?? 0,
                        ];
                        const total = times.reduce((s, v) => s + v, 0);
                        if (total === 0) return null;
                        return (
                          <div key={lap.lap} className="flex items-center gap-3">
                            <span className="text-xs text-slate-500 w-10 shrink-0 text-right">
                              {lap.lap === 0 ? "Warm" : `Lap ${lap.lap}`}
                            </span>
                            <div className="flex h-4 flex-1 rounded overflow-hidden gap-px">
                              {times.map((t, i) => {
                                const pct = (t / total) * 100;
                                if (pct < 0.5) return null;
                                return (
                                  <div
                                    key={i}
                                    className={`${ZONE_COLORS[i]} shrink-0`}
                                    style={{ width: `${pct}%` }}
                                    title={`${ZONE_NAMES[i]}: ${fmtDuration(t)}`}
                                  />
                                );
                              })}
                            </div>
                            <span className="text-xs text-slate-500 w-12 shrink-0 tabular-nums">
                              {fmtDuration(total)}
                            </span>
                          </div>
                        );
                      })}
                      <div className="flex gap-3 mt-2 flex-wrap">
                        {ZONE_NAMES.map((name, i) => (
                          <div key={i} className="flex items-center gap-1.5 text-xs text-slate-500">
                            <span className={`w-2.5 h-2.5 rounded-sm ${ZONE_COLORS[i]}`} />
                            {name}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })()}
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-slate-500 mb-0.5">{label}</p>
      <p className="text-lg font-semibold text-slate-100">{value}</p>
    </div>
  );
}
