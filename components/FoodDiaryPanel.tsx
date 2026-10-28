"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

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
  icon: string | null;
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

// Styled like the dashboard: coloured pills like its workout types, mono
// value chips like its BPM badges, track-style rows with a thumbnail.
const MEAL_STYLE = [
  "bg-amber-500/20 text-amber-400 border-amber-500/30",    // Breakfast
  "bg-emerald-500/20 text-emerald-400 border-emerald-500/30", // Lunch
  "bg-sky-500/20 text-sky-400 border-sky-500/30",          // Dinner
  "bg-purple-500/20 text-purple-400 border-purple-500/30", // Snacks
];

// Lose It!'s own food icon, cached by /api/loseit/icon.
function FoodIcon({ icon, size = 36 }: { icon: string | null; size?: number }) {
  return (
    <div className="rounded-lg bg-slate-800/80 shrink-0 flex items-center justify-center" style={{ width: size, height: size }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`/api/loseit/icon?name=${encodeURIComponent(icon ?? "Default")}`} alt="" width={29} height={29} loading="lazy" style={{ width: size * 0.8, height: size * 0.8 }} />
    </div>
  );
}

function KcalChip({ kcal, big = false }: { kcal: number | null; big?: boolean }) {
  return (
    <span className={`font-mono font-semibold text-green-400 bg-green-500/10 rounded px-1.5 py-0.5 tabular-nums whitespace-nowrap ${big ? "text-sm" : "text-xs"}`}>
      {round(kcal)}{big ? " kcal" : ""}
    </span>
  );
}

function Macros({ t, className = "" }: { t: { proteinG: number | null; carbsG: number | null; fatG: number | null }; className?: string }) {
  return (
    <span className={`tabular-nums whitespace-nowrap ${className}`}>
      <span className="text-sky-400/80">P {grams(t.proteinG)}</span>
      <span className="text-slate-600"> · </span>
      <span className="text-amber-400/80">C {grams(t.carbsG)}</span>
      <span className="text-slate-600"> · </span>
      <span className="text-rose-400/80">F {grams(t.fatG)}</span>
    </span>
  );
}

// Eaten against the daily limit (Settings → Nutrition goals), like Lose It!'s Calories bar.
function CalorieBar({ eaten, limit }: { eaten: number; limit: number }) {
  const left = limit - eaten;
  const pct = Math.min(100, (eaten / limit) * 100);
  return (
    <div className="mb-4">
      <div className="flex items-baseline justify-between text-xs mb-1.5">
        <span className="text-slate-400">Calories <span className="text-slate-300 tabular-nums">{round(eaten)}</span> of <span className="tabular-nums">{round(limit)}</span></span>
        <span className={`font-semibold tabular-nums ${left >= 0 ? "text-green-400" : "text-rose-400"}`}>
          {round(Math.abs(left))} {left >= 0 ? "under" : "over"}
        </span>
      </div>
      <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
        <div className={`h-full rounded-full transition-all ${left >= 0 ? "bg-green-500" : "bg-rose-500"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// onChanged: called after this panel adds, removes or copies food, so the
// page can reload its own numbers (Eaten today, the calories chart).
export function FoodDiaryPanel({ dailyLimit = null, onChanged }: { dailyLimit?: number | null; onChanged?: () => void }) {
  const today = isoDate(new Date());
  const [date, setDate] = useState(today);
  const [diary, setDiary] = useState<Diary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [copyMsg, setCopyMsg] = useState<{ text: string; error: boolean } | null>(null);

  // Right-click menu closes on any click, scroll, resize or Escape.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  function openMenu(e: React.MouseEvent, target: Menu["target"]) {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, target });
  }

  // Copies a whole meal (into the same meal) or one food (into the chosen
  // meal) into today's Lose It! diary.
  async function copyToToday(body: object, label: string) {
    setMenu(null);
    setCopyMsg({ text: `Adding ${label} to today…`, error: false });
    try {
      const res = await fetch("/api/loseit/copy", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fromDate: date, ...body }),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || `Copy failed (${res.status})`);
      if (date === out.toDate) applyDay(out.day);
      onChanged?.();
      setCopyMsg({ text: `Added ${label} to today.`, error: false });
    } catch (e) {
      setCopyMsg({ text: e instanceof Error ? e.message : "Copy failed", error: true });
    }
  }

  // Add/remove answer with the day re-read from Lose It!; keep the sync status fields.
  const applyDay = (d: Partial<Diary>) => setDiary(prev => (prev ? { ...prev, ...d } : prev));
  const added = (d: Partial<Diary>) => { applyDay(d); onChanged?.(); };

  // Foods from the export have no entry id; the server then matches them by
  // meal, name and calories, so they can be removed too.
  const foodKey = (f: Food, meal: number) => f.entryId ?? `${meal}|${f.name}`;

  async function remove(f: Food, meal: number) {
    setMenu(null);
    if (!confirm(`Delete ${f.name} from your Lose It! diary?`)) return;
    setRemoving(foodKey(f, meal));
    setError(null);
    try {
      const res = await fetch("/api/loseit/log", {
        method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ date, entryId: f.entryId, name: f.name, meal, kcal: f.kcal }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Remove failed (${res.status})`);
      added(body);
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
  // Today always shows all four meals (empty ones too); other days only the meals with food.
  const meals = !diary ? [] : date === today && diary.connected
    ? MEALS.map((name, meal) => diary.meals.find(m => m.meal === meal)
      ?? { meal, name, foods: [] as Food[], totals: { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 } })
    : diary.meals;
  const navBtn = "rounded-lg border border-white/10 bg-slate-800/60 hover:bg-slate-700/60 disabled:opacity-40 text-xs px-2.5 py-1.5 text-slate-300 transition-colors";

  return (
    <section className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <h2 className="flex items-center gap-2.5 text-sm font-semibold text-slate-100">
          <span className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0 bg-green-500/15 text-base" aria-hidden>🍽️</span>
          Food diary
          <span className="text-xs font-medium border rounded-full px-2.5 py-0.5 bg-green-500/20 text-green-300 border-green-500/30">{title}</span>
          {loading && <span className="text-xs font-normal text-slate-500">loading…</span>}
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

      {adding && <AddFoodPanel date={date} onAdded={added} />}

      {error && <p className="text-sm text-rose-300">{error}</p>}
      {copyMsg && <p className={`mb-2 text-xs ${copyMsg.error ? "text-rose-300" : "text-emerald-300"}`}>{copyMsg.text}</p>}

      {diary && !diary.connected && diary.meals.length === 0 && (
        <p className="text-sm text-slate-400">
          Connect your Lose It! account in{" "}
          <Link href="/settings?tab=nutrition" className="text-emerald-300 hover:text-emerald-200">Settings → Nutrition</Link>{" "}
          to see the foods you log each day.
        </p>
      )}

      {diary && diary.connected && meals.length === 0 && !loading && (
        <p className="text-sm text-slate-500">Nothing logged.</p>
      )}

      {diary && dailyLimit != null && diary.connected && (date === today || diary.meals.length > 0) && (
        <CalorieBar eaten={diary.totals.kcal} limit={dailyLimit} />
      )}

      {meals.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          {meals.map(m => (
            <div
              key={m.meal}
              onContextMenu={m.foods.length ? e => openMenu(e, { kind: "meal", meal: m.meal, name: m.name }) : undefined}
              className="rounded-xl bg-slate-800/40 border border-white/5 p-3 min-w-0 flex flex-col"
            >
              <div className="flex items-center justify-between gap-2 px-1 mb-1">
                <span className={`text-xs font-medium border rounded-full px-2.5 py-0.5 ${MEAL_STYLE[m.meal] ?? MEAL_STYLE[3]}`}>{m.name}</span>
                <KcalChip kcal={m.totals.kcal} big />
              </div>
              {m.foods.length > 0 && <Macros t={m.totals} className="block px-1 mb-2 text-[11px] text-right" />}
              {m.foods.length === 0 && <p className="px-1 py-3 text-xs text-slate-500">Nothing logged yet.</p>}
              <ul className="space-y-0.5">
                {m.foods.map((f, i) => (
                  <li
                    key={i}
                    onContextMenu={e => openMenu(e, { kind: "food", meal: m.meal, food: f })}
                    className="group flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-slate-800/60 transition-colors"
                  >
                    <FoodIcon icon={f.icon} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-100 truncate group-hover:text-green-400 transition-colors" title={f.name}>{f.name}</p>
                      <p className="text-xs text-slate-500 truncate">{[f.brand, amount(f)].filter(Boolean).join(" · ")}</p>
                    </div>
                    <div className="flex flex-col items-end gap-0.5 shrink-0">
                      <KcalChip kcal={f.kcal} />
                      <Macros t={f} className="text-[10px]" />
                    </div>
                    <button
                      onClick={() => remove(f, m.meal)}
                      disabled={removing !== null}
                      title="Delete from Lose It!"
                      aria-label={`Delete ${f.name}`}
                      className={`shrink-0 p-1 rounded text-slate-600 hover:text-rose-400 transition-all disabled:opacity-40 ${removing === foodKey(f, m.meal) ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
                    >
                      {removing === foodKey(f, m.meal) ? "…" : "×"}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {diary && diary.meals.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs">
          <span className="flex items-center gap-2 text-slate-300">
            Total <KcalChip kcal={diary.totals.kcal} big />
            <Macros t={diary.totals} className="text-xs" />
          </span>
          {diary.lastSyncAt && (
            <span className="text-slate-500">
              Synced from Lose It! {new Date(diary.lastSyncAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
        </div>
      )}

      {diary?.lastError && <p className="mt-2 text-xs text-rose-300">Last sync failed: {diary.lastError}</p>}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y}>
          {menu.target.kind === "meal" ? (() => {
            const t = menu.target;
            return (
              <button role="menuitem" onClick={() => copyToToday({ meal: t.meal }, t.name)} className="block w-full text-left px-3 py-1.5 text-slate-200 hover:bg-slate-700/60">
                Add to today
              </button>
            );
          })() : (() => {
            const t = menu.target;
            const item = { entryId: t.food.entryId, name: t.food.name, meal: t.meal, kcal: t.food.kcal };
            return (
              <>
                {MEALS.map((name, toMeal) => (
                  <button key={name} role="menuitem" onClick={() => copyToToday({ items: [item], toMeal }, `${t.food.name} (${name})`)} className="block w-full text-left px-3 py-1.5 text-slate-200 hover:bg-slate-700/60">
                    Add to {name}
                  </button>
                ))}
                <div className="my-1 border-t border-white/10" />
                <button role="menuitem" onClick={() => remove(t.food, t.meal)} className="block w-full text-left px-3 py-1.5 text-rose-300 hover:bg-rose-500/15">
                  Delete
                </button>
              </>
            );
          })()}
        </ContextMenu>
      )}
    </section>
  );
}

// A right-click menu at the pointer. Rendered on <body> through a portal:
// inside the panel, its backdrop blur would make position: fixed relative
// to the panel instead of the window. Measured before painting so it opens
// up/left of the pointer when it would otherwise run off screen.
function ContextMenu({ x, y, children }: { x: number; y: number; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y, ready: false });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = x + width > window.innerWidth - 8 ? Math.max(8, x - width) : x;
    const top = y + height > window.innerHeight - 8 ? Math.max(8, y - height) : y;
    setPos({ left, top, ready: true });
  }, [x, y]);
  return createPortal(
    <div
      ref={ref}
      role="menu"
      onClick={e => e.stopPropagation()}
      style={{ left: pos.left, top: pos.top, visibility: pos.ready ? "visible" : "hidden" }}
      className="fixed z-50 min-w-[180px] rounded-lg border border-white/10 bg-slate-900/95 backdrop-blur-sm shadow-xl py-1 text-xs"
    >
      {children}
    </div>,
    document.body,
  );
}

type Menu = {
  x: number;
  y: number;
  target: { kind: "meal"; meal: number; name: string } | { kind: "food"; meal: number; food: Food };
};

// ── Add food ───────────────────────────────────────────────────────────────

interface SearchFood { pk: string; name: string; brand: string | null; icon: string | null; locale: string | null; mine: boolean; timesLogged: number }
interface FoodDetails {
  quantity: number;     // Lose It!'s default amount, in `units`
  units: string | null;
  grams: number | null; // weight of that default amount, if known
  preferGrams: boolean; // offer grams first (the food's unit is a cup/spoon/ounce, not a count)
  kcal: number | null; proteinG: number | null; carbsG: number | null; fatG: number | null;
}

type Unit = "food" | "gram";

const trimNum = (n: number) => String(Math.round(n * 100) / 100);

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
  const [unit, setUnit] = useState<Unit>("food");
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
      const d = body as FoodDetails;
      setDetails(d);
      const grams = d.preferGrams && d.grams != null;
      setUnit(grams ? "gram" : "food");
      setQty(grams ? String(Math.round(d.grams!)) : trimNum(d.quantity));
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : "Couldn't load that food", error: true });
    }
  }

  // Switching unit converts the amount typed rather than reinterpreting it.
  function changeUnit(next: Unit) {
    if (!details || details.grams == null || next === unit) return;
    const n = Number(qty);
    if (n > 0) setQty(next === "gram" ? String(Math.round(n / details.quantity * details.grams)) : trimNum(n / details.grams * details.quantity));
    setUnit(next);
  }

  const amountN = Number(qty);
  const base = details ? (unit === "gram" ? details.grams : details.quantity) : null;
  const scale = base && amountN > 0 ? amountN / base : null;
  const gramsNow = details?.grams != null && scale != null ? details.grams * scale : null;
  const scaled = (v: number | null) => (v == null || scale == null ? null : v * scale);

  async function add() {
    if (!picked || !details || !(amountN > 0)) return;
    setSaving(true); setMessage(null);
    try {
      const res = await fetch("/api/loseit/log", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...picked, date, meal, quantity: amountN, unit }),
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
                <button onClick={() => pick(f)} className="group w-full text-left px-2 py-1 text-xs hover:bg-slate-700/40 rounded-lg flex items-center justify-between gap-3">
                  <span className="min-w-0 flex items-center gap-2.5">
                    <FoodIcon icon={f.icon} size={28} />
                    <span className="truncate">
                      <span className="text-slate-200 group-hover:text-green-400 transition-colors">{f.name}</span>
                      {f.brand && <span className="text-slate-500"> · {f.brand}</span>}
                    </span>
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
          <div className="text-sm text-slate-200 flex items-center gap-2.5">
            <FoodIcon icon={picked.icon} size={32} />
            <span>{picked.name}{picked.brand && <span className="text-slate-500"> · {picked.brand}</span>}</span>
            <button onClick={() => { setPicked(null); setDetails(null); }} className="ml-2 text-xs text-slate-500 hover:text-slate-300">← results</button>
          </div>
          {!details ? <p className="text-xs text-slate-500">Loading…</p> : (
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <span className="block text-[11px] text-slate-400">Amount</span>
                <div className="flex gap-1.5">
                  <input
                    inputMode={unit === "gram" ? "numeric" : "decimal"}
                    value={qty}
                    onChange={e => setQty(unit === "gram" ? e.target.value.replace(/\D/g, "") : e.target.value)}
                    aria-label="Amount"
                    className={`${input} w-20`}
                  />
                  {details.grams != null ? (
                    <select value={unit} onChange={e => changeUnit(e.target.value as Unit)} aria-label="Unit" className={input}>
                      <option value="gram">grams</option>
                      <option value="food">{details.units ?? "servings"}</option>
                    </select>
                  ) : (
                    <span className="self-center text-xs text-slate-400">{details.units ?? "servings"}</span>
                  )}
                </div>
              </div>
              <label className="space-y-1">
                <span className="block text-[11px] text-slate-400">Meal</span>
                <select value={meal} onChange={e => setMeal(Number(e.target.value))} className={input}>
                  {MEALS.map((m, i) => <option key={m} value={i}>{m}</option>)}
                </select>
              </label>
              <div className="text-xs text-slate-300 pb-2 tabular-nums">
                {unit === "food" && gramsNow != null && <span className="text-slate-500">{Math.round(gramsNow)} g · </span>}
                {round(scaled(details.kcal))} kcal
                <span className="text-slate-500"> · P {grams(scaled(details.proteinG))} · C {grams(scaled(details.carbsG))} · F {grams(scaled(details.fatG))}</span>
              </div>
              <button onClick={add} disabled={saving || !(amountN > 0)} className={primary}>
                {saving ? "Adding…" : `Add to ${new Date(`${date}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`}
              </button>
            </div>
          )}
          {/* Below the row and always shown, so the controls above never shift. */}
          {details && (
            <p className="text-[11px] text-slate-500">
              Lose It!&apos;s serving: {trimNum(details.quantity)} {details.units ?? "serving"}
              {details.grams != null ? ` = ${Math.round(details.grams)} g` : ""}
            </p>
          )}
        </div>
      )}

      {message && <p className={`text-xs ${message.error ? "text-rose-300" : "text-emerald-300"}`}>{message.text}</p>}
    </div>
  );
}
