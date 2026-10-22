"use client";

import { useEffect, useState } from "react";

export interface RunFeedbackValue {
  date: string;
  title: string;
  effort: number | null;
  feel: number | null;
  notes: string | null;
}

export const FEEL_OPTIONS = [
  { v: 1, emoji: "😫", label: "Very weak" },
  { v: 2, emoji: "😕", label: "Weak" },
  { v: 3, emoji: "😐", label: "Normal" },
  { v: 4, emoji: "🙂", label: "Strong" },
  { v: 5, emoji: "😄", label: "Very strong" },
] as const;

const EFFORT_LABELS: Record<number, string> = {
  1: "Very easy", 2: "Very easy", 3: "Easy", 4: "Easy", 5: "Moderate",
  6: "Moderate", 7: "Hard", 8: "Hard", 9: "Very hard", 10: "Maximal",
};

// Green → amber → red as effort climbs.
function effortColor(n: number, active: boolean): string {
  if (!active) return "bg-slate-800/70 border-white/10 text-slate-400 hover:text-slate-200";
  if (n <= 3) return "bg-emerald-500/25 border-emerald-400/60 text-emerald-200";
  if (n <= 6) return "bg-amber-500/25 border-amber-400/60 text-amber-200";
  if (n <= 8) return "bg-orange-500/25 border-orange-400/60 text-orange-200";
  return "bg-red-500/25 border-red-400/60 text-red-200";
}

// Small chip for a run's collapsed Summary row.
export function RunFeedbackChip({ value }: { value: RunFeedbackValue | undefined }) {
  if (!value || (value.effort == null && value.feel == null)) return null;
  const feel = FEEL_OPTIONS.find(f => f.v === value.feel);
  return (
    <span
      className="text-[11px] shrink-0 px-1.5 py-0.5 rounded-md bg-slate-800/80 border border-white/10 text-slate-300 tabular-nums"
      title={[value.effort != null ? `Effort ${value.effort}/10` : "", feel ? `Felt ${feel.label.toLowerCase()}` : "", value.notes ?? ""].filter(Boolean).join(" · ")}
    >
      {value.effort != null && <>RPE {value.effort}</>}
      {value.effort != null && feel && " "}
      {feel?.emoji}
    </span>
  );
}

// "How did it feel?" — effort (1-10), feel (1-5) and notes for a finished
// run. Effort/feel save on click; notes on blur. Read by the Coach.
export function RunFeedbackPanel({ date, title, value, onSaved }: {
  date: string;
  title: string;
  value: RunFeedbackValue | undefined;
  onSaved: (v: RunFeedbackValue | null) => void;
}) {
  const [effort, setEffort] = useState<number | null>(value?.effort ?? null);
  const [feel, setFeel] = useState<number | null>(value?.feel ?? null);
  const [notes, setNotes] = useState(value?.notes ?? "");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  // Folds down to its title once both effort and feel are set; clicking the
  // title opens/closes it.
  const [open, setOpen] = useState(!(value?.effort != null && value?.feel != null));
  const pick = (e: number | null, f: number | null) => {
    setEffort(e);
    setFeel(f);
    if (e != null && f != null && (effort == null || feel == null)) setOpen(false);
    void save({ effort: e, feel: f, notes });
  };

  useEffect(() => {
    setEffort(value?.effort ?? null);
    setFeel(value?.feel ?? null);
    setNotes(value?.notes ?? "");
  }, [value?.effort, value?.feel, value?.notes]);

  async function save(next: { effort: number | null; feel: number | null; notes: string }) {
    setStatus("saving");
    try {
      const res = await fetch("/api/run-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, title, effort: next.effort, feel: next.feel, notes: next.notes }),
      });
      const d = await res.json() as { feedback?: RunFeedbackValue | null; error?: string };
      if (!res.ok) throw new Error(d.error);
      onSaved(d.feedback ?? null);
      setStatus("saved");
      setTimeout(() => setStatus(s => (s === "saved" ? "idle" : s)), 1500);
    } catch {
      setStatus("error");
    }
  }

  return (
    <div onClick={e => e.stopPropagation()} className="rounded-lg bg-slate-900/60 border border-white/10 p-3 space-y-2.5">
      <button type="button" onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between gap-2 text-left">
        <span className="flex items-center gap-2 min-w-0">
          <span className="text-slate-500 text-[10px]">{open ? "▼" : "▶"}</span>
          <span className="text-xs text-slate-300 font-medium">How did it feel?</span>
          {!open && (effort != null || feel != null) && (
            <span className="text-[11px] text-slate-400 truncate">
              {effort != null ? `Effort ${effort}/10 · ${EFFORT_LABELS[effort]}` : ""}
              {effort != null && feel != null ? " · " : ""}
              {feel != null ? `${FEEL_OPTIONS.find(f => f.v === feel)?.emoji} ${FEEL_OPTIONS.find(f => f.v === feel)?.label}` : ""}
              {notes.trim() ? " · 📝" : ""}
            </span>
          )}
        </span>
        <span className={`text-[11px] shrink-0 ${status === "error" ? "text-red-400" : "text-slate-500"}`}>
          {status === "saving" ? "Saving…" : status === "saved" ? "Saved ✓" : status === "error" ? "Couldn't save" : open ? "The Coach reads this" : ""}
        </span>
      </button>

      {open && (<>

      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px] text-slate-500">
          <span>Effort</span>
          <span>{effort != null ? `${effort}/10 · ${EFFORT_LABELS[effort]}` : "1 = very easy, 10 = all out"}</span>
        </div>
        <div className="grid grid-cols-10 gap-1">
          {Array.from({ length: 10 }, (_, i) => i + 1).map(n => (
            <button
              key={n}
              type="button"
              onClick={() => pick(effort === n ? null : n, feel)}
              className={`h-7 rounded-md border text-xs font-medium tabular-nums transition-colors ${effortColor(n, effort === n)}`}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px] text-slate-500">
          <span>Feel</span>
          <span>{FEEL_OPTIONS.find(f => f.v === feel)?.label ?? "How your body felt"}</span>
        </div>
        <div className="grid grid-cols-5 gap-1">
          {FEEL_OPTIONS.map(f => (
            <button
              key={f.v}
              type="button"
              title={f.label}
              onClick={() => pick(effort, feel === f.v ? null : f.v)}
              className={`h-8 rounded-md border text-lg transition-colors ${
                feel === f.v ? "bg-sky-500/25 border-sky-400/60" : "bg-slate-800/70 border-white/10 grayscale hover:grayscale-0"
              }`}
            >
              {f.emoji}
            </button>
          ))}
        </div>
      </div>

      <textarea
        value={notes}
        onChange={e => setNotes(e.target.value)}
        onBlur={() => { if ((value?.notes ?? "") !== notes.trim()) void save({ effort, feel, notes }); }}
        rows={2}
        placeholder="Notes — niggles, sleep, fuelling, conditions…"
        className="w-full resize-y rounded-md bg-slate-800/70 border border-white/10 text-xs px-2.5 py-1.5 text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-sky-500"
      />
      </>)}
    </div>
  );
}
