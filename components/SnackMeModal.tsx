"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

// "Snack Me!" on the Food diary's Snacks card: snacks from your own history (the Snacks entries of your last 720 days
// with food logged) that fit under what is left of the day's calorie limit (lib/snack-builder.ts). Each item can be
// added to Snacks on its own, or a whole suggestion at once. The pop-up closes with its Close button only: not on a
// click outside it, and not on Escape.
interface Macros { kcal: number; proteinG: number; carbsG: number; fatG: number }
interface SnackItem { name: string; brand: string | null; amount: number; units: string; label: string; kcal: number; proteinG: number; carbsG: number; fatG: number }
interface Snack { kind: "food" | "day"; name: string; items: SnackItem[]; totals: Macros; times: number; last: string }
interface Result { foods: Snack[]; days: Snack[]; fitFoods: number; fitDays: number }
type ItemState = { status: "busy" } | { status: "done"; logged: Macros & { name: string; label: string } } | { status: "error"; message: string };

const g = (n: number) => (n < 10 ? n.toFixed(1) : String(Math.round(n)));
const shortDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });

function MacroText({ m }: { m: Macros }) {
  return (
    <span className="tabular-nums whitespace-nowrap">
      <span className="font-mono font-semibold text-green-400">{Math.round(m.kcal)} kcal</span>
      <span className="text-sky-400/80"> · P {g(m.proteinG)}</span>
      <span className="text-amber-400/80"> · C {g(m.carbsG)}</span>
      <span className="text-rose-400/80"> · F {g(m.fatG)}</span>
    </span>
  );
}

export function SnackMeModal({ date, meal, kcalLeft, limit, testing = false, onLogged, onClose }: {
  date: string; meal: number; kcalLeft: number; limit: number | null; testing?: boolean; onLogged: (day: unknown) => void; onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [items, setItems] = useState<Record<string, ItemState>>({});
  const [bulk, setBulk] = useState(false);

  const find = useCallback(async () => {
    setLoading(true); setError(null); setItems({});
    try {
      const res = await fetch("/api/nutrition/snack-me", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kcalLeft }) });
      const text = await res.text();
      let body: { error?: string } & Partial<Result>;
      try { body = JSON.parse(text); } catch { throw new Error(`The server didn't answer properly (${res.status}) — it may be restarting; press Shuffle`); }
      if (!res.ok) throw new Error(body.error || `Failed (${res.status})`);
      setResult(body as Result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't find snacks");
    } finally {
      setLoading(false);
    }
  }, [kcalLeft]);

  useEffect(() => { find(); }, [find]);

  async function accept(k: string, it: SnackItem) {
    setItems(s => ({ ...s, [k]: { status: "busy" } }));
    try {
      const res = await fetch("/api/nutrition/create-meal/accept", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, meal, item: { name: it.name, brand: it.brand, amount: it.amount, units: it.units, kcal: it.kcal } }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed (${res.status})`);
      onLogged(body.day);
      setItems(s => ({ ...s, [k]: { status: "done", logged: body.logged } }));
    } catch (e) {
      setItems(s => ({ ...s, [k]: { status: "error", message: e instanceof Error ? e.message : "Couldn't add" } }));
    }
  }

  async function acceptAll(prefix: string, snack: Snack) {
    setBulk(true);
    for (let j = 0; j < snack.items.length; j++) {
      if (items[`${prefix}:${j}`]?.status === "done") continue;
      await accept(`${prefix}:${j}`, snack.items[j]);
    }
    setBulk(false);
  }

  const busy = bulk || Object.values(items).some(s => s.status === "busy");
  const added = Object.values(items).flatMap(s => (s.status === "done" ? [s.logged.kcal] : [])).reduce((a, b) => a + b, 0);

  const card = (s: Snack, prefix: string) => (
    <li key={prefix} className="rounded-lg bg-slate-800/40 border border-white/5 px-3 py-2.5 space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <p className="text-sm font-semibold text-slate-100">{s.kind === "day" ? `Snacks on ${shortDate(s.last)}` : s.name}</p>
        <MacroText m={s.totals} />
      </div>
      <p className="text-[11px] text-slate-500">
        {s.kind === "food" ? `Logged ${s.times}× as a snack, last ${shortDate(s.last)}` : `${s.items.length} foods eaten together`}
        {" · "}leaves {Math.round(kcalLeft - s.totals.kcal)} kcal
      </p>
      <ul className="space-y-1">
        {s.items.map((it, j) => {
          const k = `${prefix}:${j}`;
          const st = items[k];
          return (
            <li key={j} className="flex items-center gap-3 rounded-lg bg-slate-900/60 border border-white/5 px-3 py-1.5">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-slate-100 truncate">{st?.status === "done" ? st.logged.name : it.name}</p>
                <p className="text-xs text-slate-500">
                  {st?.status === "done" ? <>{st.logged.label} · <MacroText m={st.logged} /></> : <>{it.label} · <MacroText m={it} /></>}
                </p>
                {st?.status === "error" && <p className="text-xs text-rose-300 mt-0.5">{st.message}</p>}
              </div>
              {st?.status === "done" ? (
                <span className="shrink-0 text-xs text-emerald-300">Added ✓</span>
              ) : (
                <button onClick={() => accept(k, it)} disabled={busy}
                  className="shrink-0 rounded-lg border border-green-500/40 bg-green-500/15 hover:bg-green-500/25 disabled:opacity-40 text-xs font-semibold px-3 py-1 text-green-300 transition-colors">
                  {st?.status === "busy" ? "Adding…" : st?.status === "error" ? "Retry" : "Add"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {s.items.length > 1 && (
        <div className="flex justify-end">
          <button onClick={() => acceptAll(prefix, s)} disabled={busy || s.items.every((_, j) => items[`${prefix}:${j}`]?.status === "done")}
            className="rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-xs font-medium px-3 py-1.5 text-white transition-colors">
            {bulk ? "Adding…" : "Add all"}
          </button>
        </div>
      )}
    </li>
  );

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-[2px] p-4">
      <div role="dialog" aria-label="Snack Me!" className="w-full max-w-2xl max-h-[90vh] flex flex-col rounded-xl bg-slate-900 border border-white/10 shadow-2xl">
        <div className="flex items-start justify-between gap-3 p-5 pb-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-100">Snack Me! 🍫</h3>
            <p className="text-xs text-slate-400 mt-0.5">
              <span className="font-mono font-semibold text-green-400">{kcalLeft} kcal</span> left{limit != null ? ` of ${limit}` : ""}
              {testing && <span className="ml-2 text-[10px] rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-300 px-1.5 py-0.5">test budget, not what&apos;s really left</span>}
            </p>
            {added > 0 && <p className="text-xs text-slate-300 mt-0.5">Added {Math.round(added)} kcal · <span className="text-slate-500">{Math.round(kcalLeft - added)} kcal left</span></p>}
          </div>
          <button onClick={onClose} className="shrink-0 rounded-lg border border-white/10 bg-slate-800/60 hover:bg-slate-700/60 text-sm px-3 py-1.5 text-slate-300 transition-colors">
            Close
          </button>
        </div>

        <div className="px-5 pb-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-300">
          <button onClick={find} disabled={loading || busy}
            className="rounded-lg border border-sky-500/40 bg-sky-500/15 hover:bg-sky-500/25 disabled:opacity-40 font-semibold px-2.5 py-1 text-sky-300 transition-colors">
            Shuffle
          </button>
          <span className="text-slate-500">
            {result ? `${result.fitFoods} of your snacks and ${result.fitDays} past snack days fit` : "Snacks from your last 720 logged days that fit"}
          </span>
        </div>

        <div className="px-5 pb-5 overflow-y-auto space-y-3">
          {loading && <p className="py-6 text-center text-sm text-slate-400">Looking through your snacks…</p>}
          {error && <p className="text-sm text-rose-300">{error}</p>}
          {result && !loading && result.foods.length === 0 && result.days.length === 0 && (
            <p className="py-6 text-center text-sm text-slate-400">None of your past snacks fit under {kcalLeft} kcal.</p>
          )}
          {result && !loading && result.foods.length > 0 && (
            <>
              <p className="text-xs font-medium text-slate-300">Single snacks</p>
              <ul className="space-y-2">{result.foods.map((s, i) => card(s, `f${i}`))}</ul>
            </>
          )}
          {result && !loading && result.days.length > 0 && (
            <>
              <p className="text-xs font-medium text-slate-300 pt-1">Snacks you&apos;ve had together</p>
              <ul className="space-y-2">{result.days.map((s, i) => card(s, `d${i}`))}</ul>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
