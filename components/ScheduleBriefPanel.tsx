"use client";

import { useCallback, useEffect, useState } from "react";
import { BriefBullets } from "./BriefBullets";

// "Next two weeks" at the top of the Runna Schedule card. The mileage and key
// sessions come from the plan, added up by the app. The AI writes one sentence
// on the shape of the fortnight; it is rewritten when the plan or the day
// changes or after an activity update, as soon as the AI is available (the
// server does it after the sync, or hourly; this panel also checks back while
// the dashboard is open). "Refresh" forces a new one.

interface Brief { summary: string; createdAt: string; model: string | null }
interface State {
  facts: string[] | null;
  brief: Brief | null;
  stale: boolean;
  writing: boolean;
  error: string | null;
  /** Why a wanted refresh couldn't start yet (the AI wasn't reachable). */
  waiting: string | null;
}

const RECHECK_MS = 60_000; // while stale and waiting for the AI
const POLL_MS = 4_000;     // while one is being written

function ago(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

export function ScheduleBriefPanel() {
  const [state, setState] = useState<State | null>(null);

  const load = useCallback(async (): Promise<State | null> => {
    try {
      const res = await fetch("/api/coach/brief");
      if (!res.ok) return null;
      const d = await res.json() as State;
      setState(d);
      return d;
    } catch {
      return null;
    }
  }, []);

  // Ask the server for a new sentence (only if it's out of date, unless forced),
  // then show whatever state it is now in.
  const request = useCallback(async (force: boolean) => {
    try {
      await fetch("/api/coach/brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
    } catch { /* the next load shows the real state */ }
    await load();
  }, [load]);

  // On open: show what's saved, and ask for a new sentence if it's out of date.
  useEffect(() => {
    void load().then(d => {
      if (d && d.stale && !d.writing) void request(false);
    });
  }, [load, request]);

  // While one is being written, check back until it lands.
  useEffect(() => {
    if (!state?.writing) return;
    const t = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(t);
  }, [state?.writing, load]);

  // Out of date and the AI wasn't reachable: keep trying while the dashboard is
  // open, so it refreshes as soon as the AI DJ service is back.
  useEffect(() => {
    if (!state || !state.stale || state.writing) return;
    const t = setInterval(() => { void request(false); }, RECHECK_MS);
    return () => clearInterval(t);
  }, [state?.stale, state?.writing, request]); // eslint-disable-line react-hooks/exhaustive-deps

  if (state === null || !state.facts) return null; // nothing planned, or not signed in

  const waiting = state.stale && !state.writing ? state.waiting : null;
  const sentence = state.brief?.summary ?? "";

  return (
    <div className="px-5 py-3 border-b border-white/10 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] uppercase tracking-wide text-slate-500">🧠 Next two weeks</p>
        <button
          onClick={() => void request(true)}
          disabled={state.writing}
          className="rounded-md border border-white/10 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-slate-800 hover:text-slate-100 disabled:opacity-50 transition-colors"
          title="Write a fresh summary now"
        >
          {state.writing ? "Writing…" : "↻ Refresh"}
        </button>
      </div>

      <BriefBullets lines={state.facts} />

      {sentence && (
        <p className={`text-[13px] leading-snug text-slate-300 italic ${state.stale ? "opacity-60" : ""}`}>{sentence}</p>
      )}

      {waiting && (
        <p className="text-xs text-amber-300">
          Waiting for the AI ({waiting}); the summary sentence will update by itself once it&apos;s back.
        </p>
      )}
      {state.error && !state.writing && !waiting && (
        <p className="text-xs text-amber-300">Couldn&apos;t write a new sentence: {state.error}</p>
      )}
      {state.brief && sentence && (
        <p className="text-[10px] text-slate-600">
          {ago(state.brief.createdAt)}{state.brief.model ? ` · ${state.brief.model}` : ""}
        </p>
      )}
    </div>
  );
}
