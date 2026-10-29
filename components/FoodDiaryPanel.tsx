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

const SYNC_EVERY_MS = 5 * 60_000; // lib/loseit-food.ts's MIN_SYNC_INTERVAL_MS

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

// onChanged: called after this panel adds, removes or copies food, so the
// page can reload its own numbers (Eaten today, the day's calorie bars).
// dayChart: drawn above the meals for the day shown (the page's calorie bars),
// given that day's eaten total from the diary.
export function FoodDiaryPanel({ onChanged, dayChart }: {
  onChanged?: () => void; dayChart?: (date: string, eaten: number) => React.ReactNode;
}) {
  const today = isoDate(new Date());
  const [date, setDate] = useState(today);
  const [diary, setDiary] = useState<Diary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  // Drag and drop between meals: what's being dragged, the meal it's over,
  // and the dropped food waiting for "Move or copy?".
  const [drag, setDrag] = useState<{ food: Food; meal: number } | null>(null);
  const [overMeal, setOverMeal] = useState<number | null>(null);
  const [drop, setDrop] = useState<{ food: Food; from: number; to: number } | null>(null);
  const [placing, setPlacing] = useState<"move" | "copy" | null>(null);
  const [copyMsg, setCopyMsg] = useState<{ text: string; error: boolean } | null>(null);
  // Clicking a food opens "change the amount".
  const [editing, setEditing] = useState<{ food: Food; meal: number } | null>(null);
  const [editQty, setEditQty] = useState("");
  const [editUnit, setEditUnit] = useState<"food" | "gram">("food");
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  function startEdit(food: Food, meal: number) {
    setMenu(null);
    setEditing({ food, meal });
    setEditQty(food.quantity == null ? "" : String(Math.round(food.quantity * 100) / 100));
    setEditUnit("food");
    setEditError(null);
  }

  async function saveEdit() {
    if (!editing) return;
    const quantity = Number(editQty);
    if (!(quantity > 0)) return;
    setSaving(true);
    setEditError(null);
    try {
      const f = editing.food;
      const res = await fetch("/api/loseit/edit", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, quantity, unit: editUnit, item: { entryId: f.entryId, name: f.name, meal: editing.meal, kcal: f.kcal } }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Edit failed (${res.status})`);
      added(body);
      setEditing(null);
    } catch (e) {
      setEditError(e instanceof Error ? e.message : "Edit failed");
    } finally {
      setSaving(false);
    }
  }

  // Escape closes the edit dialog.
  useEffect(() => {
    if (!editing || saving) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setEditing(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, saving]);

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

  // Moves the dropped food to its new meal, or copies it there (same day).
  async function place(mode: "move" | "copy") {
    if (!drop) return;
    setPlacing(mode);
    setError(null);
    try {
      const res = await fetch("/api/loseit/move", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, mode, toMeal: drop.to, item: { entryId: drop.food.entryId, name: drop.food.name, meal: drop.from, kcal: drop.food.kcal } }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `${mode === "move" ? "Move" : "Copy"} failed (${res.status})`);
      added(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Move failed");
    } finally {
      setPlacing(null);
      setDrop(null);
    }
  }

  // Escape cancels the Move/Copy question.
  useEffect(() => {
    if (!drop || placing) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setDrop(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drop, placing]);

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

  // refresh: ask the server to re-read the day from Lose It! first (it
  // throttles that to once per 5 minutes). Only the page opening, the refresh
  // button and the hourly timer do; browsing to another day just reads
  // what's stored.
  const load = useCallback(async (d: string, refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const recent = d >= shift(isoDate(new Date()), -1);
      const res = await fetch(`/api/loseit/diary?date=${d}${refresh && recent ? "&refresh=1" : ""}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed (${res.status})`);
      setDiary(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  // The first load after the page opens refreshes from Lose It! (unless a
  // refresh happened in the last 5 minutes: the server then answers from
  // what it has, so no traffic); later date changes only read what's stored.
  const opened = useRef(false);
  useEffect(() => {
    const first = !opened.current;
    opened.current = true;
    load(date, first);
  }, [date, load]);

  // Refresh button, and once an hour while the page stays open; the page's
  // own numbers (Eaten today, calorie bars) are reloaded after.
  const refreshNow = useCallback(async () => {
    await load(date, true);
    onChanged?.();
  }, [date, load, onChanged]);
  const refreshRef = useRef(refreshNow);
  refreshRef.current = refreshNow;
  useEffect(() => {
    const t = setInterval(() => { refreshRef.current(); }, 60 * 60_000);
    return () => clearInterval(t);
  }, []);

  // The server re-reads Lose It! at most every 5 minutes. After a refresh the
  // button gives way to a countdown to when the next one is allowed; at zero
  // the button comes back (nothing refreshes by itself).
  const [nowMs, setNowMs] = useState(() => Date.now());
  const lastSyncMs = diary?.connected && diary.lastSyncAt ? Date.parse(diary.lastSyncAt) : null;
  const waitUntil = lastSyncMs != null ? lastSyncMs + SYNC_EVERY_MS : null;
  useEffect(() => {
    if (waitUntil == null || Date.now() >= waitUntil) return;
    setNowMs(Date.now());
    const t = setInterval(() => {
      const n = Date.now();
      setNowMs(n);
      if (n >= waitUntil) clearInterval(t);
    }, 1000);
    return () => clearInterval(t);
  }, [waitUntil]);
  const countdown = waitUntil == null ? null : Math.max(0, Math.ceil((waitUntil - nowMs) / 1000));
  const canRefresh = date >= shift(today, -1); // older days come straight from the stored history

  const title = date === today ? "Today" : date === shift(today, -1) ? "Yesterday"
    : new Date(`${date}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  // Today always shows all four meals (empty ones too); other days only the meals with food,
  // until a food is being dragged.
  const meals = !diary ? [] : (date === today || drag) && diary.connected
    ? MEALS.map((name, meal) => diary.meals.find(m => m.meal === meal)
      ?? { meal, name, foods: [] as Food[], totals: { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 } })
    : diary.meals;
  // The dashboard's tinted buttons: sky for navigation, green for the main action.
  const navBtn = "rounded-lg border border-sky-500/40 bg-sky-500/15 hover:bg-sky-500/25 disabled:opacity-40 disabled:hover:bg-sky-500/15 text-xs font-semibold px-2.5 py-1.5 text-sky-300 transition-colors";
  const addBtn = "rounded-lg border border-green-500/40 bg-green-500/15 hover:bg-green-500/25 text-xs font-semibold px-3 py-1.5 text-green-300 transition-colors";

  return (
    <section className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <h2 className="flex items-center gap-2.5 text-sm font-semibold text-slate-100">
          <span className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0 bg-green-500/15 text-base" aria-hidden>🍽️</span>
          Food diary
          <span className="text-xs font-medium border rounded-full px-2.5 py-0.5 bg-green-500/20 text-green-300 border-green-500/30">{title}</span>
          <Link href="/settings?tab=nutrition" className="text-xs font-normal text-slate-500 hover:text-slate-300 transition-colors">Goals</Link>
          {diary?.connected && canRefresh && (
            loading ? (
              <span className="text-xs font-normal text-slate-500">refreshing…</span>
            ) : countdown != null && countdown > 0 ? (
              <span className="text-xs font-mono font-normal text-slate-500" title="The earliest the next refresh from Lose It! is allowed">
                {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, "0")}
              </span>
            ) : (
              <button
                onClick={refreshNow}
                title="Refresh from Lose It!"
                aria-label="Refresh from Lose It!"
                className="rounded-md border border-white/10 bg-slate-800/60 hover:bg-slate-700/60 text-slate-300 text-sm font-normal leading-none px-2 py-1 transition-colors"
              >
                ↻
              </button>
            )
          )}
          {loading && !(diary?.connected && canRefresh) && <span className="text-xs font-normal text-slate-500">loading…</span>}
        </h2>
        <div className="flex items-center gap-1.5">
          <button onClick={() => setDate(d => shift(d, -1))} className={navBtn} aria-label="Previous day">‹</button>
          <input
            type="date"
            value={date}
            max={today}
            onChange={e => e.target.value && setDate(e.target.value)}
            className="rounded-lg bg-sky-500/10 border border-sky-500/40 hover:bg-sky-500/20 focus:outline-none focus:ring-1 focus:ring-sky-400 text-xs font-semibold px-2 py-1.5 text-sky-200 transition-colors [color-scheme:dark]"
          />
          <button onClick={() => setDate(d => shift(d, 1))} disabled={date >= today} className={navBtn} aria-label="Next day">›</button>
          <button onClick={() => setDate(today)} disabled={date === today} className={navBtn}>Today</button>
          {diary?.connected && (
            <button onClick={() => setAdding(a => !a)} className={`${addBtn} ${adding ? "bg-green-500/30 border-green-400/60 text-green-200" : ""}`}>
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

      {diary && dayChart && diary.connected && (date === today || diary.meals.length > 0) && dayChart(date, diary.totals.kcal)}

      {meals.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          {meals.map(m => (
            <div
              key={m.meal}
              onContextMenu={m.foods.length ? e => openMenu(e, { kind: "meal", meal: m.meal, name: m.name }) : undefined}
              onDragOver={drag && drag.meal !== m.meal ? e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setOverMeal(m.meal); } : undefined}
              onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOverMeal(o => (o === m.meal ? null : o)); }}
              onDrop={drag && drag.meal !== m.meal ? e => {
                e.preventDefault();
                setDrop({ food: drag.food, from: drag.meal, to: m.meal });
                setDrag(null); setOverMeal(null);
              } : undefined}
              className={`rounded-xl border p-3 min-w-0 flex flex-col transition-colors ${
                overMeal === m.meal ? "bg-emerald-500/10 border-emerald-500/60 ring-1 ring-emerald-500/40" : "bg-slate-800/40 border-white/5"
              }`}
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
                    draggable={placing === null && !removing}
                    onDragStart={e => {
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", f.name); // Firefox won't drag without data
                      setMenu(null);
                      setDrag({ food: f, meal: m.meal });
                    }}
                    onDragEnd={() => { setDrag(null); setOverMeal(null); }}
                    onContextMenu={e => openMenu(e, { kind: "food", meal: m.meal, food: f })}
                    onClick={() => startEdit(f, m.meal)}
                    title="Click to change the amount"
                    className={`group flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-slate-800/60 transition-colors cursor-pointer active:cursor-grabbing ${
                      drag?.food === f ? "opacity-40" : ""
                    }`}
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
                      onClick={e => { e.stopPropagation(); remove(f, m.meal); }}
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

      {diary && diary.connected && (diary.meals.length > 0 || diary.lastSyncAt) && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs">
          {diary.meals.length > 0 ? (
            <span className="flex items-center gap-2 text-slate-300">
              Total <KcalChip kcal={diary.totals.kcal} big />
              <Macros t={diary.totals} className="text-xs" />
            </span>
          ) : <span />}
          {diary.lastSyncAt && (
            <span className="text-slate-500">
              Synced from Lose It! {new Date(diary.lastSyncAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
        </div>
      )}

      {diary?.lastError && <p className="mt-2 text-xs text-rose-300">Last sync failed: {diary.lastError}</p>}

      {drop && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-[2px] p-4"
          onClick={() => { if (!placing) setDrop(null); }}
        >
          <div
            role="dialog"
            aria-label="Move or copy food"
            onClick={e => e.stopPropagation()}
            className="w-full max-w-sm rounded-xl bg-slate-900 border border-white/10 shadow-2xl p-5 space-y-4"
          >
            <div className="flex items-center gap-3">
              <FoodIcon icon={drop.food.icon} size={40} />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-100 truncate">{drop.food.name}</p>
                <p className="text-xs text-slate-400">
                  <span className={`border rounded-full px-2 py-0.5 ${MEAL_STYLE[drop.from] ?? MEAL_STYLE[3]}`}>{MEALS[drop.from]}</span>
                  <span className="mx-2 text-slate-500">→</span>
                  <span className={`border rounded-full px-2 py-0.5 ${MEAL_STYLE[drop.to] ?? MEAL_STYLE[3]}`}>{MEALS[drop.to]}</span>
                </p>
              </div>
            </div>
            <p className="text-xs text-slate-400">Move it to {MEALS[drop.to]}, or keep it in {MEALS[drop.from]} too and copy it?</p>
            <div className="flex flex-wrap justify-end gap-2">
              <button onClick={() => setDrop(null)} disabled={placing !== null}
                className="rounded-lg border border-white/10 bg-slate-800/60 hover:bg-slate-700/60 disabled:opacity-40 text-sm px-3 py-1.5 text-slate-300 transition-colors">
                Cancel
              </button>
              <button onClick={() => place("copy")} disabled={placing !== null}
                className="rounded-lg border border-sky-500/40 bg-sky-500/15 hover:bg-sky-500/25 disabled:opacity-50 text-sm font-medium px-3 py-1.5 text-sky-300 transition-colors">
                {placing === "copy" ? "Copying…" : `Copy to ${MEALS[drop.to]}`}
              </button>
              <button onClick={() => place("move")} disabled={placing !== null}
                className="rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-sm font-medium px-3 py-1.5 text-white transition-colors">
                {placing === "move" ? "Moving…" : `Move to ${MEALS[drop.to]}`}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {editing && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-[2px] p-4"
          onClick={() => { if (!saving) setEditing(null); }}
        >
          <form
            role="dialog"
            aria-label="Change amount"
            onClick={e => e.stopPropagation()}
            onSubmit={e => { e.preventDefault(); saveEdit(); }}
            className="w-full max-w-sm rounded-xl bg-slate-900 border border-white/10 shadow-2xl p-5 space-y-4"
          >
            {(() => {
              const f = editing.food;
              const qty = Number(editQty);
              const ownLabel = f.units ? (UNIT_ABBR[f.units] ?? f.units.toLowerCase()) : "amount";
              // Calories scale with the amount when the unit stays the same.
              const preview = editUnit === "food" && f.kcal != null && f.quantity && qty > 0 ? (f.kcal * qty) / f.quantity : null;
              return (
                <>
                  <div className="flex items-center gap-3">
                    <FoodIcon icon={f.icon} size={40} />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-100 truncate">{f.name}</p>
                      <p className="text-xs text-slate-400">
                        <span className={`border rounded-full px-2 py-0.5 ${MEAL_STYLE[editing.meal] ?? MEAL_STYLE[3]}`}>{MEALS[editing.meal]}</span>
                        <span className="ml-2">now {amount(f) || "—"}</span>
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number" inputMode="decimal" min="0" step="any" autoFocus value={editQty}
                      onChange={e => setEditQty(e.target.value)}
                      onFocus={e => e.target.select()}
                      className="w-28 rounded-lg bg-slate-800 border border-slate-700 text-sm px-3 py-2 text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    />
                    {f.units === "Gram" ? (
                      <span className="text-sm text-slate-400">g</span>
                    ) : (
                      <select
                        value={editUnit}
                        onChange={e => setEditUnit(e.target.value as "food" | "gram")}
                        className="rounded-lg bg-slate-800 border border-slate-700 text-sm px-2 py-2 text-slate-100"
                      >
                        <option value="food">{ownLabel}</option>
                        <option value="gram">g (grams)</option>
                      </select>
                    )}
                    {preview != null && (
                      <span className="ml-auto text-xs text-slate-400">≈ <span className="font-mono text-slate-200">{Math.round(preview)}</span> kcal</span>
                    )}
                  </div>
                  {editUnit === "gram" && f.units !== "Gram" && (
                    <p className="text-[11px] text-slate-500">The amount is switched to grams, scaled from the food&apos;s logged weight.</p>
                  )}
                  {editError && <p className="text-xs text-rose-300">{editError}</p>}
                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={() => setEditing(null)} disabled={saving}
                      className="rounded-lg border border-white/10 bg-slate-800/60 hover:bg-slate-700/60 disabled:opacity-40 text-sm px-3 py-1.5 text-slate-300 transition-colors">
                      Cancel
                    </button>
                    <button type="submit" disabled={saving || !(qty > 0)}
                      className="rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-sm font-medium px-3 py-1.5 text-white transition-colors">
                      {saving ? "Saving…" : "Save"}
                    </button>
                  </div>
                </>
              );
            })()}
          </form>
        </div>,
        document.body,
      )}

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
                <button role="menuitem" onClick={() => startEdit(t.food, t.meal)} className="block w-full text-left px-3 py-1.5 text-slate-200 hover:bg-slate-700/60">
                  Edit amount
                </button>
                <div className="my-1 border-t border-white/10" />
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

interface SearchFood { pk: string; name: string; brand: string | null; icon: string | null; locale: string | null; mine: boolean; recipe: boolean; timesLogged: number }

type ResultTab = "mine" | "all" | "recipes";
const RESULT_TABS: { key: ResultTab; label: string; match: (f: SearchFood) => boolean }[] = [
  { key: "mine", label: "My Foods", match: f => f.mine && !f.recipe },
  { key: "all", label: "All Foods", match: f => !f.mine },
  { key: "recipes", label: "Recipes", match: f => f.recipe },
];
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
  const [tab, setTab] = useState<ResultTab | null>(null);
  const [picked,setPicked] = useState<SearchFood | null>(null);
  const [details, setDetails] = useState<FoodDetails | null>(null);
  const [qty, setQty] = useState("");
  const [unit, setUnit] = useState<Unit>("food");
  const [meal, setMeal] = useState(mealForNow);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  async function search(e?: React.FormEvent) {
    e?.preventDefault();
    if (query.trim().length < 2) return;
    setSearching(true); setMessage(null); setPicked(null); setDetails(null); setTab(null);
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

  // The tab shown: the one picked, else the first with results (My Foods when it has any).
  const shownTab = tab ?? (RESULT_TABS.find(t => results?.some(t.match))?.key ?? "mine");
  const shown = (results ?? []).filter((RESULT_TABS.find(t => t.key === shownTab) ?? RESULT_TABS[0]).match);

  const amountN = Number(qty);
  const base =details ? (unit === "gram" ? details.grams : details.quantity) : null;
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
          <>
          <div role="tablist" className="flex gap-1 border-b border-white/10">
            {RESULT_TABS.map(t => {
              const n = results.filter(t.match).length;
              const on = shownTab === t.key;
              return (
                <button key={t.key} role="tab" aria-selected={on} onClick={() => setTab(t.key)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-t-lg border-b-2 -mb-px transition-colors ${
                    on ? "border-emerald-400 text-emerald-300 bg-white/5" : "border-transparent text-slate-400 hover:text-slate-200"
                  }`}>
                  {t.label} <span className="text-slate-500">{n}</span>
                </button>
              );
            })}
          </div>
          {shown.length === 0 && <p className="text-xs text-slate-500 py-2">Nothing in this tab.</p>}
          <ul className="max-h-80 overflow-y-auto">
            {shown.map(f => (
              <li key={f.pk}>
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
          </>
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
