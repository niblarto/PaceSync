"use client";

import { useState, useEffect } from "react";
import type { RunnaWorkout, WorkoutType } from "@/app/api/runna/workouts/route";

const TYPE_META: Record<WorkoutType, { label: string; color: string }> = {
  easy_run:  { label: "Easy Run",   color: "bg-green-500/20 text-green-400 border-green-500/30" },
  long_run:  { label: "Long Run",   color: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" },
  tempo:     { label: "Tempo",      color: "bg-orange-500/20 text-orange-400 border-orange-500/30" },
  interval:  { label: "Intervals",  color: "bg-red-500/20 text-red-400 border-red-500/30" },
  race:      { label: "Race",       color: "bg-red-600/20 text-red-300 border-red-500/30" },
  strength:  { label: "Strength",   color: "bg-slate-500/20 text-slate-400 border-slate-500/30" },
  other_run: { label: "Run",        color: "bg-blue-500/20 text-blue-400 border-blue-500/30" },
  rest:      { label: "Rest",       color: "bg-slate-700/20 text-slate-500 border-slate-700/30" },
};

const ZONE_COLORS = [
  "",
  "bg-emerald-500 text-black",
  "bg-green-500 text-black",
  "bg-yellow-500 text-black",
  "bg-orange-500 text-black",
  "bg-red-500 text-black",
];

const ZONE_NAMES = ["", "Warm Up", "Easy", "Aerobic", "Threshold", "Maximum"];

function formatDuration(secs: number): string {
  if (!secs) return "";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h${m > 0 ? ` ${m}m` : ""}`;
  return `${m}m`;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

function isToday(dateStr: string): boolean {
  return dateStr === new Date().toISOString().slice(0, 10);
}

function isTomorrow(dateStr: string): boolean {
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  return dateStr === tomorrow;
}

function dayLabel(dateStr: string): string {
  if (isToday(dateStr)) return "Today";
  if (isTomorrow(dateStr)) return "Tomorrow";
  return formatDate(dateStr);
}

export function RunnaCard() {
  const [workouts, setWorkouts] = useState<RunnaWorkout[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/runna/workouts")
      .then(r => r.json())
      .then((d: { workouts?: RunnaWorkout[]; error?: string }) => {
        if (d.error) throw new Error(d.error);
        setWorkouts(d.workouts ?? []);
      })
      .catch(e => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 overflow-hidden">
      <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
        <div>
          <h2 className="font-semibold flex items-center gap-2">
            <span className="text-base">🏃</span> Runna Schedule
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">Next 4 weeks</p>
        </div>
      </div>

      {loading && (
        <div className="divide-y divide-white/10">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="px-5 py-3 animate-pulse flex gap-3">
              <div className="w-16 h-4 bg-slate-800 rounded" />
              <div className="flex-1 h-4 bg-slate-800 rounded" />
              <div className="w-12 h-4 bg-slate-800 rounded" />
            </div>
          ))}
        </div>
      )}

      {error && (
        <p className="px-5 py-4 text-sm text-red-400">{error}</p>
      )}

      {!loading && !error && workouts.length === 0 && (
        <p className="px-5 py-4 text-sm text-slate-500">No upcoming workouts found.</p>
      )}

      {!loading && !error && workouts.length > 0 && (
        <div className="divide-y divide-white/10">
          {workouts.map(w => {
            const meta = TYPE_META[w.type];
            const isOpen = expanded === w.uid;
            const isRun = w.type !== "strength" && w.type !== "rest";

            return (
              <div key={w.uid}>
                <button
                  onClick={() => setExpanded(isOpen ? null : w.uid)}
                  className="w-full px-5 py-3 flex items-center gap-3 text-left hover:bg-slate-800/40 transition-colors"
                >
                  {/* Date */}
                  <span className={`text-xs shrink-0 w-20 ${isToday(w.date) ? "text-green-400 font-semibold" : "text-slate-500"}`}>
                    {dayLabel(w.date)}
                  </span>

                  {/* Title */}
                  <span className="text-sm text-slate-200 flex-1 min-w-0 truncate">{w.title}</span>

                  {/* Distance + duration */}
                  {isRun && (
                    <span className="text-xs text-slate-500 shrink-0">
                      {w.distanceMi ? `${w.distanceMi}mi` : ""}
                      {w.distanceMi && w.durationSec ? " · " : ""}
                      {w.durationSec ? formatDuration(w.durationSec) : ""}
                    </span>
                  )}
                  {!isRun && w.durationSec > 0 && (
                    <span className="text-xs text-slate-500 shrink-0">{formatDuration(w.durationSec)}</span>
                  )}

                  {/* Type badge */}
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full border shrink-0 ${meta.color}`}>
                    {meta.label}
                  </span>

                  {/* Zone suggestion */}
                  {w.suggestedZone !== null && (
                    <span className={`text-xs font-bold px-2 py-0.5 rounded shrink-0 ${ZONE_COLORS[w.suggestedZone]}`}>
                      Z{w.suggestedZone} {ZONE_NAMES[w.suggestedZone]}
                    </span>
                  )}

                  <span className="text-slate-600 text-xs shrink-0">{isOpen ? "▲" : "▼"}</span>
                </button>

                {isOpen && (
                  <div className="px-5 pb-4 pt-1 bg-slate-800/20 space-y-2">
                    <div className="space-y-1">
                      {w.segments.map((seg, i) => (
                        <p key={i} className="text-xs text-slate-400 leading-relaxed">{seg}</p>
                      ))}
                    </div>
                    {w.appUrl && (
                      <a
                        href={w.appUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-block text-xs text-green-400 hover:text-green-300 underline mt-1"
                        onClick={e => e.stopPropagation()}
                      >
                        View in Runna app ↗
                      </a>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
