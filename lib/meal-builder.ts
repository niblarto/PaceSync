import { getDb } from "@/lib/db";
import { loadOllamaWebKey, ollamaWebSearch } from "@/lib/web-search";
import { loadRecipeKey, searchRecipes } from "@/lib/recipe-api";
import { loadFatSecret, searchFatSecret } from "@/lib/fatsecret";
import { addLoseItFood, getLoseItFoodDetails, localIsoDate, searchLoseItFoods, type DiaryDay, type FoodRef } from "@/lib/loseit-food";

// "Create meal" on the Nutrition page's Dinner card. No AI: it offers (1) the
// dinners you have really eaten that fit what is left, worked out from the
// Lose It! food log kept locally, which can be accepted item by item, and
// (2) the recipes the recipe APIs and the web search return for the foods you
// eat most at dinner, shown as they come back.

export interface Macros { kcal: number; proteinG: number; carbsG: number; fatG: number }

export interface MealItem {
  name: string;
  brand: string | null;
  amount: number;        // in `units`
  units: string;         // "Gram", "Serving", "Each", …
  label: string;         // "150 g", "2 Servings"
  kcal: number; proteinG: number; carbsG: number; fatG: number;
}

// A dinner eaten before, whole, as logged.
export interface MealSuggestion {
  name: string;
  summary: string;
  items: MealItem[];
  totals: Macros;
  fit: boolean;          // within tolerance of the remaining budget
  date: string;          // the day it was eaten
}

export interface RecipeCard {
  source: "API Ninjas" | "FatSecret";
  title: string;
  ingredients: string[];
  instructions: string;
  nutrition: string | null; // as the API gives it
  kcal: number | null;
  servings: string | null;
  fits: boolean | null;     // calories within what's left (null when unknown)
}

export interface WebCard { title: string; url: string; snippet: string }

export interface MealResult {
  meals: MealSuggestion[];
  recipes: RecipeCard[];
  web: WebCard[];
  notes: string[];          // sources skipped or failed
}

const HISTORY_DAYS = 180; // days that have food logged, not calendar days
const DRINKS = /\b(coffee|tea|water|coke|cola|squash|latte|cappuccino|espresso|beer|wine|lager|cider|juice|energy drink|gel|isotonic|electrolyte|supplement)\b/i;

const r1 = (n: number) => Math.round(n * 10) / 10;

function plural(units: string, n: number): string {
  if (n === 1 || units === "Each" || /s$/i.test(units)) return units;
  return /(sh|ch|x)$/i.test(units) ? `${units}es` : `${units}s`;
}

// Within ±10% of the calories left, and each macro within 15% (at least 10 g) of what's left.
function fits(t: Macros, b: Macros): boolean {
  const near = (v: number, target: number, floor: number) => Math.abs(v - target) <= Math.max(floor, target * 0.15);
  return Math.abs(t.kcal - b.kcal) <= b.kcal * 0.1 && near(t.proteinG, b.proteinG, 10) && near(t.carbsG, b.carbsG, 10) && near(t.fatG, b.fatG, 10);
}

// ── Past dinners ───────────────────────────────────────────────────────────

// Dinners actually eaten in the history window (whole days of Dinner entries) that fit what is left:
// no more than the calories left, and as close as possible to the calories and macros wanted.
function historyMeals(budget: Macros, today: string): MealSuggestion[] {
  const rows = getDb().prepare(`
    SELECT date, name, brand, quantity, units, kcal, protein_g, carbs_g, fat_g FROM loseit_food_log
    WHERE date >= (SELECT MIN(date) FROM (SELECT DISTINCT date FROM loseit_food_log ORDER BY date DESC LIMIT ?))
      AND date < ? AND meal = 2 AND kcal > 0 AND quantity > 0
    ORDER BY date DESC, seq
  `).all(HISTORY_DAYS, today) as { date: string; name: string; brand: string | null; quantity: number; units: string | null; kcal: number; protein_g: number | null; carbs_g: number | null; fat_g: number | null }[];

  const days = new Map<string, typeof rows>();
  for (const r of rows) days.set(r.date, [...(days.get(r.date) ?? []), r]);

  const scored: { meal: MealSuggestion; names: Set<string>; distance: number }[] = [];
  days.forEach((list, date) => {
    const items: MealItem[] = list.map(r => {
      const units = r.units ?? "Serving";
      return {
        name: r.name.trim(), brand: r.brand, amount: r.quantity, units,
        label: units === "Gram" ? `${Math.round(r.quantity)} g` : `${r1(r.quantity)} ${plural(units, r.quantity)}`,
        kcal: Math.round(r.kcal), proteinG: r1(r.protein_g ?? 0), carbsG: r1(r.carbs_g ?? 0), fatG: r1(r.fat_g ?? 0),
      };
    });
    const totals: Macros = {
      kcal: items.reduce((a, i) => a + i.kcal, 0), proteinG: r1(items.reduce((a, i) => a + i.proteinG, 0)),
      carbsG: r1(items.reduce((a, i) => a + i.carbsG, 0)), fatG: r1(items.reduce((a, i) => a + i.fatG, 0)),
    };
    if (items.length < 2 || totals.kcal > budget.kcal * 1.03 || totals.kcal < Math.max(200, budget.kcal * 0.4)) return;
    const distance = 2 * Math.abs(totals.kcal - budget.kcal) / budget.kcal
      + 2 * Math.max(0, budget.proteinG - totals.proteinG) / Math.max(budget.proteinG, 30) // protein short counts double
      + Math.abs(totals.carbsG - budget.carbsG) / Math.max(budget.carbsG, 30)
      + Math.abs(totals.fatG - budget.fatG) / Math.max(budget.fatG, 15);
    const main = [...items].sort((a, b) => b.kcal - a.kcal).slice(0, 3).map(i => i.name);
    const when = new Date(`${date}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
    scored.push({
      distance, names: new Set(items.map(i => i.name.toLowerCase())),
      meal: { name: `Dinner from ${when}`, summary: main.join(", "), items, totals, fit: fits(totals, budget), date },
    });
  });

  // Best three, skipping near-repeats of a dinner already chosen (the same foods again).
  const picked: typeof scored = [];
  for (const c of scored.sort((a, b) => a.distance - b.distance)) {
    const same = picked.some(p => {
      let shared = 0;
      c.names.forEach(n => { if (p.names.has(n)) shared++; });
      return shared / Math.min(c.names.size, p.names.size) > 0.6;
    });
    if (!same) picked.push(c);
    if (picked.length === 3) break;
  }
  return picked.map(p => p.meal);
}

// What to search recipes for: the foods that supply the most protein at dinner (oil and rice don't make
// a recipe search), reduced to their core words: "Scottish Honey Roast Hot Smoked Salmon" → "Smoked Salmon".
function dinnerSearchTerms(n: number): string[] {
  const rows = getDb().prepare(`
    SELECT name FROM loseit_food_log
    WHERE date >= (SELECT MIN(date) FROM (SELECT DISTINCT date FROM loseit_food_log ORDER BY date DESC LIMIT ?))
      AND meal = 2 AND kcal > 0 AND protein_g > 0
    GROUP BY LOWER(TRIM(name)) HAVING COUNT(*) >= 2
    ORDER BY SUM(protein_g) DESC LIMIT 20
  `).all(HISTORY_DAYS) as { name: string }[];
  const terms: string[] = [];
  for (const { name } of rows) {
    if (DRINKS.test(name)) continue;
    const words = name.replace(/[™®️]/g, "").split(",")[0].trim().split(/\s+/);
    const term = words.slice(-2).join(" ").toLowerCase();
    if (term.length > 2 && !terms.includes(term)) terms.push(term);
    if (terms.length === n) break;
  }
  return terms;
}

// ── Generate ───────────────────────────────────────────────────────────────

// status: told each step as it starts (and what the last one found); the pop-up lists them.
// onPartial: given the past dinners as soon as they're found, so they show while the searches run.
export async function createMeals(
  budget: Macros, status: (line: string) => void = () => {}, onPartial: (meals: MealSuggestion[]) => void = () => {},
): Promise<{ ok: true; result: MealResult } | { ok: false; error: string }> {
  const notes: string[] = [];

  status("Finding your past dinners that fit what's left…");
  const meals = historyMeals(budget, localIsoDate());
  status(meals.length ? `${meals.length} of your past dinners fit what's left` : "None of your past dinners fit what's left");
  if (meals.length) onPartial(meals);

  const terms = dinnerSearchTerms(4);
  if (terms.length) status(`Searching for recipes with what you eat at dinner: ${terms.join(", ")}`);
  else notes.push("Not enough Dinner history to know what to search recipes for");

  // The web search.
  let web: WebCard[] = [];
  if (terms.length) {
    if (loadOllamaWebKey()) {
      status("Searching the web…");
      const s = await ollamaWebSearch(`healthy high protein dinner recipe ${terms.slice(0, 2).join(" ")} around ${Math.round(budget.kcal)} calories`);
      if (s.ok) {
        web = s.results.map(r => ({ title: r.title, url: r.url, snippet: r.content.slice(0, 400) }));
        status(`Web search: ${web.length} result${web.length === 1 ? "" : "s"}`);
      } else {
        notes.push(`Web search: ${s.error}`);
        status(`Web search failed (${s.error})`);
      }
    } else {
      notes.push("Web search skipped: no key saved");
    }
  }

  // The recipe APIs.
  const recipes: RecipeCard[] = [];
  const recipeKey = loadRecipeKey();
  const fatSecret = loadFatSecret();
  if (terms.length && (recipeKey || fatSecret)) {
    status(`Looking up recipes (${[recipeKey && "API Ninjas", fatSecret && "FatSecret"].filter(Boolean).join(", ")})…`);
    const range = { kcalFrom: budget.kcal * 0.7, kcalTo: budget.kcal * 1.1 };
    const found = await Promise.all([
      ...(recipeKey ? terms.map(q => searchRecipes(q, recipeKey).then(r => ({ source: "API Ninjas" as const, r }))) : []),
      ...(fatSecret ? terms.map(q => searchFatSecret(q, range, fatSecret).then(r => ({ source: "FatSecret" as const, r }))) : []),
    ]);
    const seen = new Set<string>();
    for (const { source, r } of found) {
      if (!r.ok) { const n = `${source}: ${r.error}`; if (!notes.includes(n)) notes.push(n); continue; }
      for (const x of r.recipes.slice(0, 3)) {
        const k = `${source}|${x.title.toLowerCase()}`;
        if (seen.has(k)) continue;
        seen.add(k);
        recipes.push({
          source, title: x.title, ingredients: x.ingredients, instructions: x.instructions, nutrition: x.nutrition, kcal: x.kcal, servings: x.servings,
          fits: x.kcal == null ? null : x.kcal <= budget.kcal * 1.05,
        });
      }
    }
    // Ones that fit the calories left first.
    recipes.sort((a, b) => Number(b.fits === true) - Number(a.fits === true));
    status(`Recipes: ${recipes.length} found`);
  } else if (terms.length) {
    notes.push("Recipe lookup skipped: no recipe API saved");
  }

  if (!meals.length && !recipes.length && !web.length) {
    return { ok: false, error: notes.length ? `Nothing found. ${notes.join("; ")}` : "Nothing found — try again" };
  }
  return { ok: true, result: { meals, recipes: recipes.slice(0, 16), web, notes } };
}

// ── Background jobs ────────────────────────────────────────────────────────

// The searches can take a while, longer than a proxy or browser will hold one request open, so the
// route starts a job and the page polls it. Kept on globalThis because Next can load this module more than once.
// log: what the run has done so far, oldest first; the last line is what it's doing now.
// partial: the past dinners, available before the searches finish.
type Running = { status: "running"; log: string[]; partial: MealSuggestion[] };
type Job = Running | { status: "done"; log: string[]; result: MealResult } | { status: "error"; log: string[]; error: string };
const jobs: Map<string, Job> = ((globalThis as { __mealJobs?: Map<string, Job> }).__mealJobs ??= new Map());

export function startMealJob(budget: Macros): string {
  const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const log: string[] = [];
  const running: Running = { status: "running", log, partial: [] };
  jobs.set(id, running);
  createMeals(budget, line => log.push(line), meals => { running.partial = meals; })
    .then(r => jobs.set(id, r.ok ? { status: "done", log, result: r.result } : { status: "error", log, error: r.error }))
    .catch(e => jobs.set(id, { status: "error", log, error: e instanceof Error ? e.message : String(e) }))
    .finally(() => setTimeout(() => jobs.delete(id), 30 * 60_000));
  return id;
}

export function mealJob(id: string): Job | null {
  return jobs.get(id) ?? null;
}

// ── Accept one ingredient ──────────────────────────────────────────────────

export interface AcceptItem { name: string; brand: string | null; amount: number; units: string; kcal: number }

// Finds the ingredient in Lose It! (My Foods first, else the top search hit)
// and logs it to the day's meal in the amount it was eaten before. Returns the
// day as re-read from Lose It! and what was really logged.
export async function acceptMealItem(item: AcceptItem, date: string, meal: number): Promise<{ day: DiaryDay; logged: Macros & { name: string; label: string } }> {
  const key = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
  const mine = getDb().prepare("SELECT pk, name, brand, icon, locale FROM loseit_my_foods WHERE LOWER(TRIM(name)) = ? ORDER BY rowid").all(key(item.name)) as
    { pk: string; name: string; brand: string | null; icon: string | null; locale: string | null }[];
  let food: (FoodRef & { brand: string | null; icon: string | null }) | undefined =
    [...mine].reverse().find(f => key(f.brand) === key(item.brand)) ?? (item.brand ? undefined : mine[mine.length - 1]);
  if (!food) {
    const hits = await searchLoseItFoods(item.name);
    const top = hits.find(h => !h.recipe) ?? hits[0];
    if (!top) throw new Error(`Couldn't find ${item.name} in Lose It!`);
    food = top;
  }

  const d = await getLoseItFoodDetails(food);
  let quantity: number, unit: "food" | "gram", factor: number;
  if (d.units === item.units) {
    quantity = item.amount; unit = "food"; factor = item.amount / d.quantity;
  } else if (item.units === "Gram" && d.grams != null && d.grams > 0) {
    quantity = item.amount; unit = "gram"; factor = item.amount / d.grams;
  } else if (d.kcal != null && d.kcal > 0 && item.kcal > 0) {
    factor = item.kcal / d.kcal; quantity = Math.round(factor * d.quantity * 100) / 100; unit = "food";
  } else {
    throw new Error(`Couldn't work out how much ${food.name} to log`);
  }
  const day = await addLoseItFood(food, date, meal, quantity, unit);
  const s = (v: number | null) => Math.round((v ?? 0) * factor * 10) / 10;
  const shown = unit === "gram" ? `${item.amount} g` : `${Math.round(quantity * 100) / 100} ${d.units ?? "serving"}`;
  return { day, logged: { name: food.name, label: shown, kcal: Math.round(s(d.kcal)), proteinG: s(d.proteinG), carbsG: s(d.carbsG), fatG: s(d.fatG) } };
}
