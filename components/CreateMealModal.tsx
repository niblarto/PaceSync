"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// "Create meal" on the Food diary's Dinner card. Finds dinners that suit what is
// left of the day (lib/meal-builder.ts): your own past dinners that fit, which
// can be accepted into Dinner item by item or as a whole, plus the recipes the
// recipe APIs and the web search return, shown as they came back. Only
// accepted items are logged. The pop-up closes with its Close button only: not
// on a click outside it, and not on Escape.
export interface Macros { kcal: number; proteinG: number; carbsG: number; fatG: number }

interface MealItem {
  name: string; brand: string | null; amount: number; units: string; label: string;
  kcal: number; proteinG: number; carbsG: number; fatG: number;
}
interface Meal { name: string; summary: string; items: MealItem[]; totals: Macros; fit: boolean; date: string }
// Amounts are metric (g/ml) for the whole recipe; "count" is a number of things in countUnit.
// keep: a measure left as written per Settings → Nutrition → Recipe measures (e.g. 2 tbsp); amount/unit are still its metric equivalent.
interface RecipeIngredient {
  text: string; name: string; amount: number | null; unit: "g" | "ml" | "count" | null; countUnit: string | null;
  keep: { key: string; quantity: number; label: string } | null;
}
interface RecipeCard {
  source: string; title: string; ingredients: RecipeIngredient[]; servingsN: number | null; instructions: string; nutrition: string | null;
  kcal: number | null; servings: string | null; fits: boolean | null;
}
interface WebCard { title: string; url: string; snippet: string }
interface Result { meals: Meal[]; recipes: RecipeCard[]; web: WebCard[]; notes: string[] }
type ItemState = { status: "busy" } | { status: "done"; logged: Macros & { name: string; label: string } } | { status: "error"; message: string };
type Section = "dinners" | "recipes" | "web";

const g = (n: number) => (n < 10 ? n.toFixed(1) : String(Math.round(n)));
const sum = (list: Macros[]): Macros => ({
  kcal: list.reduce((a, m) => a + m.kcal, 0), proteinG: list.reduce((a, m) => a + m.proteinG, 0),
  carbsG: list.reduce((a, m) => a + m.carbsG, 0), fatG: list.reduce((a, m) => a + m.fatG, 0),
});

const trim1 = (n: number) => String(Math.round(n * 10) / 10);
const trim2 = (n: number) => String(Math.round(n * 100) / 100);

// The amount of a recipe ingredient for `eat` servings of a recipe that makes `makes` (metric): "170 g", "2 cloves".
// null when the recipe gave no amount.
function scaledAmount(i: RecipeIngredient, eat: number, makes: number | null): { amount: number; text: string; keep: { key: string; quantity: number } | null } | null {
  if (i.amount == null || i.unit == null) return null;
  const f = eat / (makes ?? 1);
  const amount = i.amount * f;
  if (!(amount > 0)) return null;
  // A measure left as written shows as written (2 tbsp), not in metric.
  if (i.keep) return { amount, text: `${trim2(i.keep.quantity * f)} ${i.keep.label}`, keep: { key: i.keep.key, quantity: i.keep.quantity * f } };
  const text = i.unit === "count" ? `${amount < 1 ? trim2(amount) : trim1(amount)}${i.countUnit ? ` ${i.countUnit}` : ""}` : `${amount < 1 ? trim2(amount) : amount < 10 ? trim1(amount) : Math.round(amount)} ${i.unit}`;
  return { amount, text, keep: null };
}

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

export function CreateMealModal({ date, meal, remaining, onLogged, onClose }: {
  date: string; meal: number; remaining: Macros; onLogged: (day: unknown) => void; onClose: () => void;
}) {
  // Nothing runs until "Find meals" is pressed.
  const [loading, setLoading] = useState(false);
  const [started, setStarted] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [section, setSection] = useState<Section | null>(null);
  const [rejected, setRejected] = useState<Set<number>>(new Set());
  const [tab, setTab] = useState(0);
  const [items, setItems] = useState<Record<string, ItemState>>({});
  const [bulk, setBulk] = useState(false);
  const [eat, setEat] = useState<Record<number, string>>({}); // servings of each recipe to add, default 1
  const abort = useRef<AbortController | null>(null);

  const generate = useCallback(async () => {
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setLoading(true); setStarted(true); setError(null); setResult(null); setSection(null); setRejected(new Set()); setItems({}); setTab(0); setLog([]); setElapsed(0);
    // Not JSON when a proxy or a restarting server answers with an HTML error page.
    const json = async (res: Response) => {
      const text = await res.text();
      try { return JSON.parse(text); } catch { throw new Error(`The server didn't answer properly (${res.status}) — it may be restarting; press Search again`); }
    };
    try {
      const start = await fetch("/api/nutrition/create-meal", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: ctl.signal,
        body: JSON.stringify({ remaining }),
      });
      const started = await json(start);
      if (!start.ok) throw new Error(started.error || `Failed (${start.status})`);
      const giveUp = Date.now() + 10 * 60_000;
      let misses = 0;
      for (;;) {
        await new Promise(r => setTimeout(r, 1500));
        if (ctl.signal.aborted) return;
        if (Date.now() > giveUp) throw new Error("Took too long — try again");
        let job: { status: string; log?: string[]; partial?: Meal[]; result?: Result; error?: string };
        try {
          const res = await fetch(`/api/nutrition/create-meal?id=${started.jobId}`, { signal: ctl.signal });
          job = await json(res);
          if (!res.ok) throw new Error(job.error || `Failed (${res.status})`);
        } catch (e) {
          if (ctl.signal.aborted) return;
          // A blip while the server restarts: a few misses are tolerated.
          if (++misses > 5 || (e instanceof Error && /gone/.test(e.message))) throw e;
          continue;
        }
        misses = 0;
        if (job.log) setLog(job.log);
        // Past dinners are ready before the searches finish; show them now. The final result keeps the
        // same dinners in the same order, so anything accepted meanwhile stays in place.
        if (job.status === "running" && job.partial?.length) {
          const meals = job.partial;
          setResult(prev => prev ?? { meals, recipes: [], web: [], notes: [] });
        }
        if (job.status === "done") { setResult(job.result!); break; }
        if (job.status === "error") throw new Error(job.error || "Couldn't find meals");
      }
    } catch (e) {
      if (ctl.signal.aborted) return;
      setError(e instanceof Error ? e.message : "Couldn't find meals");
    } finally {
      if (!ctl.signal.aborted) setLoading(false);
    }
  }, [remaining]);

  // Stop polling when the pop-up closes.
  useEffect(() => () => abort.current?.abort(), []);

  // Seconds since the search started.
  useEffect(() => {
    if (!loading) return;
    const t0 = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(t);
  }, [loading]);

  const key = (mi: number, ii: number) => `${mi}:${ii}`;

  async function accept(mi: number, ii: number) {
    const it = result!.meals[mi].items[ii];
    const k = key(mi, ii);
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

  async function acceptAll(mi: number) {
    setBulk(true);
    for (let ii = 0; ii < result!.meals[mi].items.length; ii++) {
      if (items[key(mi, ii)]?.status === "done") continue;
      await accept(mi, ii);
    }
    setBulk(false);
  }

  const servingsToEat = (ri: number) => { const n = Number(eat[ri] ?? "1"); return n > 0 ? n : 1; };

  // Adds one recipe ingredient, scaled to the servings being eaten, as metric.
  async function acceptIngredient(ri: number, ij: number) {
    const r = result!.recipes[ri];
    const ing = r.ingredients[ij];
    const sc = scaledAmount(ing, servingsToEat(ri), r.servingsN);
    const k = `r${ri}:${ij}`;
    if (!sc || ing.unit == null) return;
    setItems(s => ({ ...s, [k]: { status: "busy" } }));
    try {
      const res = await fetch("/api/nutrition/create-meal/accept-ingredient", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, meal, item: { name: ing.name, amount: sc.amount, unit: ing.unit, countUnit: ing.countUnit, keep: sc.keep } }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed (${res.status})`);
      onLogged(body.day);
      setItems(s => ({ ...s, [k]: { status: "done", logged: body.logged } }));
    } catch (e) {
      setItems(s => ({ ...s, [k]: { status: "error", message: e instanceof Error ? e.message : "Couldn't add" } }));
    }
  }

  async function acceptAllIngredients(ri: number) {
    setBulk(true);
    const r = result!.recipes[ri];
    for (let ij = 0; ij < r.ingredients.length; ij++) {
      if (items[`r${ri}:${ij}`]?.status === "done" || !scaledAmount(r.ingredients[ij], servingsToEat(ri), r.servingsN)) continue;
      await acceptIngredient(ri, ij);
    }
    setBulk(false);
  }

  const meals = result?.meals ?? [];
  const recipes = result?.recipes ?? [];
  const web = result?.web ?? [];
  const live = meals.map((_, i) => i).filter(i => !rejected.has(i));
  const shown = live.includes(tab) ? tab : live[0];
  const m = shown != null ? meals[shown] : null;
  const busy = bulk || Object.values(items).some(s => s.status === "busy");
  const sections: { key: Section; label: string; n: number }[] = [
    { key: "dinners", label: "🕘 Your dinners", n: live.length },
    { key: "recipes", label: "🍳 Recipes", n: recipes.length },
    { key: "web", label: "🌐 Web", n: web.length },
  ];
  const sec = section && sections.find(s => s.key === section && (s.n > 0 || !result)) ? section : (sections.find(s => s.n > 0)?.key ?? "dinners");

  // What's been accepted from this meal so far, as really logged, against the budget the pop-up opened with.
  const acceptedHere = m ? m.items.flatMap((_, ii) => { const s = items[key(shown, ii)]; return s?.status === "done" ? [s.logged] : []; }) : [];
  const accepted = sum(acceptedHere);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-[2px] p-4">
      <div role="dialog" aria-label="Create meal" className="w-full max-w-2xl max-h-[90vh] flex flex-col rounded-xl bg-slate-900 border border-white/10 shadow-2xl">
        <div className="flex items-start justify-between gap-3 p-5 pb-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-100">Find dinner</h3>
            <p className="text-xs text-slate-400 mt-0.5">Left for the day: <MacroText m={remaining} /></p>
          </div>
          <button onClick={onClose} className="shrink-0 rounded-lg border border-white/10 bg-slate-800/60 hover:bg-slate-700/60 text-sm px-3 py-1.5 text-slate-300 transition-colors">
            Close
          </button>
        </div>

        <div className="px-5 pb-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-300">
          <button onClick={generate} disabled={loading || busy}
            className="rounded-lg border border-sky-500/40 bg-sky-500/15 hover:bg-sky-500/25 disabled:opacity-40 font-semibold px-2.5 py-1 text-sky-300 transition-colors">
            {started ? "Search again" : "Find meals"}
          </button>
          <span className="text-slate-500">Your past dinners that fit, plus recipes from the web and the recipe APIs</span>
        </div>

        <div className="px-5 pb-5 overflow-y-auto space-y-3">
          {!started && (
            <p className="py-8 text-center text-sm text-slate-500">
              Press <span className="text-sky-300 font-semibold">Find meals</span> to search.
            </p>
          )}
          {started && (loading || (error && log.length > 0)) && (
            <ul className="rounded-lg bg-slate-800/40 border border-white/5 px-3 py-2.5 space-y-1.5 text-xs">
              {log.map((line, i) => {
                const current = loading && i === log.length - 1;
                return (
                  <li key={i} className={`flex items-start gap-2 ${current ? "text-slate-100" : "text-slate-400"}`}>
                    {current
                      ? <span className="mt-0.5 inline-block h-3 w-3 shrink-0 rounded-full border-2 border-emerald-400 border-t-transparent animate-spin" />
                      : <span className="shrink-0 text-emerald-400">✓</span>}
                    <span>{line}</span>
                  </li>
                );
              })}
              {log.length === 0 && loading && <li className="text-slate-400">Starting…</li>}
              {loading && <li className="pt-1 text-[11px] text-slate-500 tabular-nums">{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")} elapsed</li>}
            </ul>
          )}
          {error && <p className="text-sm text-rose-300">{error}</p>}

          {result && (
            <>
              <div role="tablist" className="flex gap-1 border-b border-white/10">
                {sections.map(s => (
                  <button key={s.key} role="tab" aria-selected={s.key === sec} onClick={() => setSection(s.key)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-t-lg border-b-2 -mb-px transition-colors ${
                      s.key === sec ? "border-emerald-400 text-emerald-300 bg-white/5" : "border-transparent text-slate-400 hover:text-slate-200"
                    }`}>
                    {s.label} <span className="text-slate-500">{s.n}</span>
                  </button>
                ))}
              </div>

              {sec === "dinners" && (live.length === 0 ? (
                <p className="py-4 text-center text-sm text-slate-400">
                  {meals.length === 0 ? "None of your past dinners fit what's left." : "All dinners rejected."}
                </p>
              ) : m && shown != null && (
                <>
                  <div className="flex flex-wrap gap-1">
                    {live.map(i => (
                      <button key={i} onClick={() => setTab(i)}
                        className={`px-2.5 py-1 text-xs rounded-lg border transition-colors ${
                          i === shown ? "border-sky-500/50 bg-sky-500/15 text-sky-200" : "border-white/10 text-slate-400 hover:text-slate-200"
                        }`}>
                        {new Date(`${meals[i].date}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}
                      </button>
                    ))}
                  </div>

                  <div>
                    <p className="text-sm font-semibold text-slate-100">{m.name}</p>
                    {m.summary && <p className="text-xs text-slate-400 mt-0.5">{m.summary}</p>}
                    <p className="mt-1.5 text-xs flex flex-wrap items-center gap-x-2">
                      <MacroText m={m.totals} />
                      {!m.fit && <span className="text-amber-300">not quite on target</span>}
                    </p>
                  </div>

                  <ul className="space-y-1">
                    {m.items.map((it, ii) => {
                      const s = items[key(shown, ii)];
                      return (
                        <li key={ii} className="flex items-center gap-3 rounded-lg bg-slate-800/40 border border-white/5 px-3 py-2">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-slate-100 truncate">{s?.status === "done" ? s.logged.name : it.name}</p>
                            <p className="text-xs text-slate-500">
                              {s?.status === "done" ? <>{s.logged.label} · <MacroText m={s.logged} /></> : <>{it.label} · <MacroText m={it} /></>}
                            </p>
                            {s?.status === "error" && <p className="text-xs text-rose-300 mt-0.5">{s.message}</p>}
                          </div>
                          {s?.status === "done" ? (
                            <span className="shrink-0 text-xs text-emerald-300">Added ✓</span>
                          ) : (
                            <button onClick={() => accept(shown, ii)} disabled={busy}
                              className="shrink-0 rounded-lg border border-green-500/40 bg-green-500/15 hover:bg-green-500/25 disabled:opacity-40 text-xs font-semibold px-3 py-1.5 text-green-300 transition-colors">
                              {s?.status === "busy" ? "Adding…" : s?.status === "error" ? "Retry" : "Accept"}
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>

                  {acceptedHere.length > 0 && (
                    <p className="text-xs text-slate-300">
                      Added to Dinner: <MacroText m={accepted} />
                      <span className="text-slate-500"> · left {Math.round(remaining.kcal - accepted.kcal)} kcal</span>
                    </p>
                  )}

                  <div className="flex flex-wrap justify-end gap-2 pt-1">
                    <button onClick={() => setRejected(r => new Set(r).add(shown))} disabled={busy}
                      className="rounded-lg border border-rose-500/40 bg-rose-500/10 hover:bg-rose-500/20 disabled:opacity-40 text-sm px-3 py-1.5 text-rose-300 transition-colors">
                      Reject dinner
                    </button>
                    <button onClick={() => acceptAll(shown)} disabled={busy || m.items.every((_, ii) => items[key(shown, ii)]?.status === "done")}
                      className="rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-sm font-medium px-3 py-1.5 text-white transition-colors">
                      {bulk ? "Adding…" : "Accept all"}
                    </button>
                  </div>
                </>
              ))}

              {sec === "recipes" && (recipes.length === 0 ? (
                <p className="py-4 text-center text-sm text-slate-400">{loading ? "Still searching…" : "No recipes came back."}</p>
              ) : (
                <ul className="space-y-2">
                  {recipes.map((r, i) => (
                    <li key={i} className="rounded-lg bg-slate-800/40 border border-white/5 px-3 py-2.5 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <p className="text-sm font-semibold text-slate-100">{r.title}</p>
                        <span className="text-[10px] rounded-full border border-white/10 text-slate-400 px-1.5 py-0.5">{r.source}</span>
                        {r.fits === true && <span className="text-[10px] rounded-full border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 px-1.5 py-0.5">within your calories</span>}
                      </div>
                      {r.nutrition && <p className="text-xs text-green-400/90 tabular-nums">{r.nutrition}</p>}
                      {r.servings && <p className="text-xs text-slate-500">Servings: {r.servings}</p>}
                      {r.ingredients.length > 0 && (
                        <details className="text-xs text-slate-400">
                          <summary className="cursor-pointer text-slate-300 hover:text-slate-100">Ingredients ({r.ingredients.length}) · add to Dinner</summary>
                          <div className="mt-2 space-y-2">
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                              <label className="flex items-center gap-1.5">
                                Servings to add
                                <input inputMode="decimal" value={eat[i] ?? "1"} onChange={e => setEat(s => ({ ...s, [i]: e.target.value }))} aria-label="Servings to add"
                                  className="w-14 rounded-lg bg-slate-800 border border-slate-700 text-xs px-2 py-1 text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500" />
                              </label>
                              <span className="text-slate-500">{r.servingsN ? `recipe makes ${trim1(r.servingsN)}` : "servings not given: amounts are for the whole recipe"}</span>
                              <button onClick={() => acceptAllIngredients(i)} disabled={busy}
                                className="ml-auto rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-xs font-medium px-3 py-1.5 text-white transition-colors">
                                Add all
                              </button>
                            </div>
                            <ul className="space-y-1">
                              {r.ingredients.map((x, j) => {
                                const sc = scaledAmount(x, servingsToEat(i), r.servingsN);
                                const s = items[`r${i}:${j}`];
                                return (
                                  <li key={j} className="flex items-center gap-3 rounded-lg bg-slate-900/60 border border-white/5 px-3 py-1.5">
                                    <div className="flex-1 min-w-0">
                                      <p className="text-sm text-slate-100 truncate">
                                        {s?.status === "done" ? s.logged.name : x.name}
                                        {sc && <span className="ml-2 font-mono text-xs text-sky-300">{s?.status === "done" ? s.logged.label : sc.text}</span>}
                                      </p>
                                      <p className="text-[11px] text-slate-600 truncate">
                                        {s?.status === "done" ? <MacroText m={s.logged} /> : <>recipe says: {x.text}</>}
                                      </p>
                                      {s?.status === "error" && <p className="text-xs text-rose-300 mt-0.5">{s.message}</p>}
                                    </div>
                                    {s?.status === "done" ? (
                                      <span className="shrink-0 text-xs text-emerald-300">Added ✓</span>
                                    ) : !sc ? (
                                      <span className="shrink-0 text-[11px] text-slate-600">no amount</span>
                                    ) : (
                                      <button onClick={() => acceptIngredient(i, j)} disabled={busy}
                                        className="shrink-0 rounded-lg border border-green-500/40 bg-green-500/15 hover:bg-green-500/25 disabled:opacity-40 text-xs font-semibold px-3 py-1 text-green-300 transition-colors">
                                        {s?.status === "busy" ? "Adding…" : s?.status === "error" ? "Retry" : "Add"}
                                      </button>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                          </div>
                        </details>
                      )}
                      {r.instructions && (
                        <details className="text-xs text-slate-400">
                          <summary className="cursor-pointer text-slate-300 hover:text-slate-100">Method</summary>
                          <p className="mt-1">{r.instructions}</p>
                        </details>
                      )}
                    </li>
                  ))}
                </ul>
              ))}

              {sec === "web" && (web.length === 0 ? (
                <p className="py-4 text-center text-sm text-slate-400">{loading ? "Still searching…" : "The web search returned nothing."}</p>
              ) : (
                <ul className="space-y-2">
                  {web.map((w, i) => (
                    <li key={i} className="rounded-lg bg-slate-800/40 border border-white/5 px-3 py-2.5">
                      <a href={w.url} target="_blank" rel="noreferrer" className="text-sm font-semibold text-sky-300 hover:text-sky-200 underline-offset-2 hover:underline">{w.title}</a>
                      <p className="text-[11px] text-slate-600 truncate">{w.url}</p>
                      {w.snippet && <p className="mt-1 text-xs text-slate-400">{w.snippet}</p>}
                    </li>
                  ))}
                </ul>
              ))}

              {!loading && result.notes.length > 0 && (
                <ul className="text-[11px] text-amber-300/80 space-y-0.5">
                  {result.notes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
