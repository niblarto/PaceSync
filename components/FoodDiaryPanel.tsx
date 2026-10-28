"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

// The Lose It! food diary for one day, by meal. Opening today or yesterday
// asks the server to re-read them from Lose It! first (it throttles that to
// once per 5 minutes, ~4.6 KB a time); older days come straight from the
// stored history. "Add food" searches Lose It!'s food database and adds to
// the diary of the day being shown; foods read from Lose It! can be removed.
// Mirrors lib/loseit-food.ts's DiaryDay.
interface Food {
  entryId: string | null;
  name: string;
  brand: string | null;
  quantity: number | null;
  units: string | null;
  kcal: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
}
interface Totals { kcal: number; proteinG: number; carbsG: number; fatG: number }
interface Diary {
  date: string;
  meals: { meal: number; name: string; foods: Food[]; totals: Totals }[];
  totals: Totals;
  connected: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  sync: { status: string; error?: string } | null;
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function shift(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return isoDate(d);
}

const UNIT_ABBR: Record<string, string> = { Gram: "g", Milliliter: "ml", Milligram: "mg", Liter: "l", Ounce: "oz" };

// "7 g", "1 Serving", "2 Servings", "6 Pieces", "1.5 Imperial Pints".
function amount(f: Food): string {
  if (f.quantity == null) return "";
  const q = Math.round(f.quantity * 100) / 100;
  if (!f.units) return String(q);
  if (UNIT_ABBR[f.units]) return `${q} ${UNIT_ABBR[f.units]}`;
  const plural = q === 1 || f.units === "Each" ? f.units : /(s|sh|ch|x)$/i.test(f.units) ? `${f.units}es` : `${f.units}s`;
  return `${q} ${plural}`;
}

const round = (n: number | null) => (n == null ? "—" : Math.round(n).toLocaleString("en-GB"));
const grams = (n: number | null) => (n == null ? "—" : n < 10 ? n.toFixed(1) : String(Math.round(n)));

function Macros({ t, className = "" }: { t: { proteinG: number | null; carbsG: number | null; fatG: number | null }; className?: string }) {
  return (
    <span className={`tabular-nums ${className}`}>
      P {grams(t.proteinG)} · C {grams(t.carbsG)} · F {grams(t.fatG)}
    </span>
  );
}

export function FoodDiaryPanel() {
  const today = isoDate(new Date());
  const [date, setDate] = useState(today);
  const [diary, setDiary] = useState<Diary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  // Add/remove answer with the day re-read from Lose It!; keep the sync status fields.
  const applyDay = (d: Partial<Diary>) => setDiary(prev => (prev ? { ...prev, ...d } : prev));

  async function remove(f: Food) {
    if (!f.entryId || !confirm(`Remove ${f.name} from your Lose It! diary?`)) return;
    setRemoving(f.entryId);
    setError(null);
    try {
      const res = await fetch("/api/loseit/log", {
        method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ date, entryId: f.entryId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Remove failed (${res.status})`);
      applyDay(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Remove failed");
    } finally {
      setRemoving(null);
    }
  }

  const load = useCallback(async (d: string) => {
    setLoading(true);
    setError(null);
    try {
      const recent = d >= shift(isoDate(new Date()), -1);
      const res = await fetch(`/api/loseit/diary?date=${d}${recent ? "&refresh=1" : ""}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed (${res.status})`);
      setDiary(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(date); }, [date, load]);

  const title = date === today ? "Today" : date === shift(today, -1) ? "Yesterday"
    : new Date(`${date}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const navBtn = "rounded-lg border border-white/10 bg-slate-800/60 hover:bg-slate-700/60 disabled:opacity-40 text-xs px-2.5 py-1.5 text-slate-300 transition-colors";

  return (
    <section className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <h2 className="text-sm font-semibold text-slate-300">
          Food diary · {title}
          {loading && <span className="ml-2 text-xs font-normal text-slate-500">loading…</span>}
        </h2>
        <div className="flex items-center gap-1.5">
          <button onClick={() => setDate(d => shift(d, -1))} className={navBtn} aria-label="Previous day">‹</button>
          <input
            type="date"
            value={date}
            max={today}
            onChange={e => e.target.value && setDate(e.target.value)}
            className="rounded-lg bg-slate-800 border border-slate-700 text-xs px-2 py-1.5 text-slate-200"
          />
          <button onClick={() => setDate(d => shift(d, 1))} disabled={date >= today} className={navBtn} aria-label="Next day">›</button>
          {date !== today && <button onClick={() => setDate(today)} className={navBtn}>Today</button>}
          {diary?.connected && (
            <button onClick={() => setAdding(a => !a)} className={`${navBtn} ${adding ? "text-emerald-300 border-emerald-500/40" : ""}`}>
              {adding ? "Close" : "+ Add food"}
            </button>
          )}
        </div>
      </div>

      {adding && <AddFoodPanel date={date} onAdded={applyDay} />}

      {error && <p className="text-sm text-rose-300">{error}</p>}

      {diary && !diary.connected && diary.meals.length === 0 && (
        <p className="text-sm text-slate-400">
          Connect your Lose It! account in{" "}
          <Link href="/settings?tab=nutrition" className="text-emerald-300 hover:text-emerald-200">Settings → Nutrition</Link>{" "}
          to see the foods you log each day.
        </p>
      )}

      {diary && diary.connected && diary.meals.length === 0 && !loading && (
        <p className="text-sm text-slate-500">Nothing logged{date === today ? " yet" : ""}.</p>
      )}

      {diary && diary.meals.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          {diary.meals.map(m => (
            <div key={m.meal} className="rounded-lg bg-slate-800/40 border border-white/5 p-3 min-w-0">
              <div className="flex items-baseline justify-between gap-2 mb-2">
                <h3 className="text-sm font-medium text-slate-200">{m.name}</h3>
                <span className="text-xs text-slate-300 tabular-nums">{round(m.totals.kcal)} kcal</span>
              </div>
              <ul className="space-y-1.5">
                {m.foods.map((f, i) => (
                  <li key={i} className="flex items-start justify-between gap-3 text-xs">
                    <div className="min-w-0">
                      <div className="text-slate-200 truncate" title={f.name}>{f.name}</div>
                      <div className="text-slate-500 truncate">
                        {[f.brand, amount(f)].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                    <div className="flex items-start gap-1.5 shrink-0">
                      <div className="text-right">
                        <div className="text-slate-300 tabular-nums">{round(f.kcal)}</div>
                        <Macros t={f} className="text-[10px] text-slate-500" />
                      </div>
                      {f.entryId && (
                        <button
                          onClick={() => remove(f)}
                          disabled={removing !== null}
                          title="Remove from Lose It!"
                          aria-label={`Remove ${f.name}`}
                          className="text-slate-600 hover:text-rose-300 disabled:opacity-40 leading-none px-0.5"
                        >
                          {removing === f.entryId ? "…" : "×"}
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              <div className="mt-2 pt-2 border-t border-white/5 text-[11px] text-slate-500 text-right">
                <Macros t={m.totals} />
              </div>
            </div>
          ))}
        </div>
      )}

      {diary && diary.meals.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="text-slate-300">
            Total <span className="tabular-nums font-medium">{round(diary.totals.kcal)} kcal</span>
            <span className="text-slate-500"> · protein {grams(diary.totals.proteinG)} g · carbs {grams(diary.totals.carbsG)} g · fat {grams(diary.totals.fatG)} g</span>
          </span>
          {diary.lastSyncAt && (
            <span className="text-slate-500">
              Synced from Lose It! {new Date(diary.lastSyncAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
        </div>
      )}

      {diary?.lastError && <p className="mt-2 text-xs text-rose-300">Last sync failed: {diary.lastError}</p>}
    </section>
  );
}

// ── Add food ───────────────────────────────────────────────────────────────

interface SearchFood { pk: string; name: string; brand: string | null; icon: string | null; locale: string | null; mine: boolean; timesLogged: number }
interface FoodDetails { quantity: number; units: string | null; kcal: number | null; proteinG: number | null; carbsG: number | null; fatG: number | null }

const MEALS = ["Breakfast", "Lunch", "Dinner", "Snacks"];

function mealForNow(): number {
  const h = new Date().getHours();
  return h < 11 ? 0 : h < 15 ? 1 : h >= 17 && h < 22 ? 2 : 3;
}

function AddFoodPanel({ date, onAdded }: { date: string; onAdded: (d: Partial<Diary>) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchFood[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<SearchFood | null>(null);
  const [details, setDetails] = useState<FoodDetails | null>(null);
  const [qty, setQty] = useState("");
  const [meal, setMeal] = useState(mealForNow);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  async function search(e?: React.FormEvent) {
    e?.preventDefault();
    if (query.trim().length < 2) return;
    setSearching(true); setMessage(null); setPicked(null); setDetails(null);
    try {
      const res = await fetch(`/api/loseit/search?q=${encodeURIComponent(query.trim())}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Search failed (${res.status})`);
      setResults(body.foods);
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : "Search failed", error: true });
    } finally {
      setSearching(false);
    }
  }

  // Lose It! fills in the food's default amount and its calories/macros.
  async function pick(f: SearchFood) {
    setPicked(f); setDetails(null); setMessage(null);
    try {
      const res = await fetch("/api/loseit/food", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed (${res.status})`);
      setDetails(body);
      setQty(String(body.quantity));
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : "Couldn't load that food", error: true });
    }
  }

  const amountN = Number(qty);
  const scale = details && amountN > 0 ? amountN / details.quantity : null;
  const scaled = (v: number | null) => (v == null || scale == null ? null : v * scale);

  async function add() {
    if (!picked || !details || !(amountN > 0)) return;
    setSaving(true); setMessage(null);
    try {
      const res = await fetch("/api/loseit/log", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...picked, date, meal, quantity: amountN }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Add failed (${res.status})`);
      onAdded(body);
      setMessage({ text: `Added ${picked.name} to ${MEALS[meal]}.`, error: false });
      setPicked(null); setDetails(null);
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : "Add failed", error: true });
    } finally {
      setSaving(false);
    }
  }

  const input = "rounded-lg bg-slate-800 border border-slate-700 text-sm px-3 py-2 text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500";
  const primary = "rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-sm font-medium px-4 py-2 text-white transition-colors";

  return (
    <div className="mb-4 rounded-lg bg-slate-800/40 border border-emerald-500/20 p-3 space-y-3">
      <form onSubmit={search} className="flex gap-2">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search Lose It! foods, e.g. banana"
          autoFocus
          className={`${input} flex-1 min-w-0`}
        />
        <button type="submit" disabled={searching || query.trim().length < 2} className={primary}>
          {searching ? "Searching…" : "Search"}
        </button>
      </form>

      {results && !picked && (
        results.length === 0 ? <p className="text-xs text-slate-500">No foods found.</p> : (
          <ul className="max-h-80 overflow-y-auto">
            {results.map((f, i) => (
              <li key={f.pk}>
                {/* Section headings: My Foods matches come first, then Lose It!'s database. */}
                {(i === 0 || f.mine !== results[i - 1].mine) && (
                  <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wide text-slate-500">{f.mine ? "My Foods" : "All foods"}</div>
                )}
                <button onClick={() => pick(f)} className="w-full text-left px-2 py-1.5 text-xs hover:bg-slate-700/40 rounded flex justify-between gap-3">
                  <span className="min-w-0">
                    <span className="text-slate-200">{f.name}</span>
                    {f.brand && <span className="text-slate-500"> · {f.brand}</span>}
                  </span>
                  {f.mine && f.timesLogged > 0 && <span className="text-slate-500 shrink-0 tabular-nums">logged {f.timesLogged}×</span>}
                </button>
              </li>
            ))}
          </ul>
        )
      )}

      {picked && (
        <div className="space-y-2">
          <div className="text-sm text-slate-200">
            {picked.name}{picked.brand && <span className="text-slate-500"> · {picked.brand}</span>}
            <button onClick={() => { setPicked(null); setDetails(null); }} className="ml-2 text-xs text-slate-500 hover:text-slate-300">← results</button>
          </div>
          {!details ? <p className="text-xs text-slate-500">Loading…</p> : (
            <div className="flex flex-wrap items-end gap-3">
              <label className="space-y-1">
                <span className="block text-[11px] text-slate-400">Amount{details.units ? ` (${details.units})` : ""}</span>
                <input inputMode="decimal" value={qty} onChange={e => setQty(e.target.value)} className={`${input} w-24`} />
              </label>
              <label className="space-y-1">
                <span className="block text-[11px] text-slate-400">Meal</span>
                <select value={meal} onChange={e => setMeal(Number(e.target.value))} className={input}>
                  {MEALS.map((m, i) => <option key={m} value={i}>{m}</option>)}
                </select>
              </label>
              <div className="text-xs text-slate-300 pb-2 tabular-nums">
                {round(scaled(details.kcal))} kcal
                <span className="text-slate-500"> · P {grams(scaled(details.proteinG))} · C {grams(scaled(details.carbsG))} · F {grams(scaled(details.fatG))}</span>
              </div>
              <button onClick={add} disabled={saving || !(amountN > 0)} className={primary}>
                {saving ? "Adding…" : `Add to ${new Date(`${date}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`}
              </button>
            </div>
          )}
        </div>
      )}

      {message && <p className={`text-xs ${message.error ? "text-rose-300" : "text-emerald-300"}`}>{message.text}</p>}
    </div>
  );
}
