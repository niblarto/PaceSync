import { getDb } from "@/lib/db";
import { loadOllamaWebKey, ollamaWebSearch } from "@/lib/web-search";
import { loadRecipeKey, searchRecipes, type RecipeIngredient } from "@/lib/recipe-api";
import { getFatSecretRecipe, loadFatSecret, searchFatSecret } from "@/lib/fatsecret";
import { LOSEIT_MASS_G, LOSEIT_VOLUME_ML, MEASURE_DEFS, toMetric, type MeasureSettings } from "@/lib/units";
import { loadMeasures } from "@/lib/measures-config";
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

// One recipe ingredient, amount converted to metric for the whole recipe (null when the recipe gave none).
// "count" is a number of things (2 cloves, 1 can) in countUnit.
// keep: a US measure left as written (its Convert box is off in Settings): the original quantity, e.g. 2 tbsp.
export interface CardIngredient {
  text: string; name: string; amount: number | null; unit: "g" | "ml" | "count" | null; countUnit: string | null;
  keep: { key: string; quantity: number; label: string } | null;
}

export interface RecipeCard {
  source: "API Ninjas" | "FatSecret";
  title: string;
  ingredients: CardIngredient[];
  servingsN: number | null; // how many servings the ingredient amounts make
  instructions: string;
  nutrition: string | null; // as the API gives it
  kcal: number | null;
  servings: string | null;
  fits: boolean | null;     // calories within what's left (null when unknown)
  fatSecretId: string | null;
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
  const measures = loadMeasures();

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
          source, title: x.title, ingredients: x.ingredients.map(i => cardIngredient(i, measures)), servingsN: x.servingsN, instructions: x.instructions,
          nutrition: x.nutrition, kcal: x.kcal, servings: x.servings, fits: x.kcal == null ? null : x.kcal <= budget.kcal, fatSecretId: x.id,
        });
      }
    }
    // Recipes over the calories left are dropped (ones with no calorie figure can't be judged, so stay);
    // those known to fit come first.
    const before = recipes.length;
    for (let i = recipes.length - 1; i >= 0; i--) if (recipes[i].fits === false) recipes.splice(i, 1);
    const hidden = before - recipes.length;
    recipes.sort((a, b) => Number(b.fits === true) - Number(a.fits === true));
    recipes.splice(16);
    status(`Recipes: ${recipes.length} found${hidden ? ` (${hidden} over your calories left, hidden)` : ""}`);

    // FatSecret's search lists ingredient names only; the full recipe has their amounts.
    const needAmounts = recipes.filter(r => r.fatSecretId).slice(0, 8);
    if (fatSecret && needAmounts.length) {
      status("Getting ingredient amounts from FatSecret…");
      await Promise.all(needAmounts.map(async r => {
        const full = await getFatSecretRecipe(r.fatSecretId!, fatSecret);
        if (!full || !full.ingredients.length) return;
        r.ingredients = full.ingredients.map(i => cardIngredient(i, measures));
        r.servingsN = full.servingsN;
        if (full.instructions) r.instructions = full.instructions;
      }));
    }
  } else if (terms.length) {
    notes.push("Recipe lookup skipped: no recipe API saved");
  }

  if (!meals.length && !recipes.length && !web.length) {
    return { ok: false, error: notes.length ? `Nothing found. ${notes.join("; ")}` : "Nothing found — try again" };
  }
  return { ok: true, result: { meals, recipes, web, notes } };
}

// American measures → metric, once, here (the ones set to convert in Settings → Nutrition → Recipe measures;
// the rest keep their original quantity too); everything after works in grams and millilitres.
function cardIngredient(i: RecipeIngredient, measures: MeasureSettings): CardIngredient {
  const m = toMetric(i.quantity, i.unit, measures);
  return { text: i.text, name: i.name, amount: m ? m.amount : null, unit: m ? m.unit : null, countUnit: m?.countUnit ?? null, keep: m?.keep ?? null };
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

// ── Add a recipe ingredient ────────────────────────────────────────────────

export interface RecipeAmount { name: string; amount: number; unit: "g" | "ml" | "count"; countUnit: string | null; keep?: { key: string; quantity: number } | null }

// "Snapper (Fish) (Mixed Species)" → "Snapper"; "chicken breast, boneless" → "chicken breast".
function searchName(name: string): string {
  return name.replace(/\([^)]*\)/g, " ").split(",")[0].replace(/\s+/g, " ").trim();
}

// The Lose It! food for a recipe ingredient's name: My Foods first (the foods you actually log, most-logged
// first), else Lose It!'s own database. Tries the whole name, then its last two words, then the last word.
async function findFoodByName(name: string): Promise<FoodRef & { brand: string | null; icon: string | null }> {
  const clean = searchName(name);
  const words = clean.split(" ");
  const tries = [clean, words.slice(-2).join(" "), words[words.length - 1]].filter((t, i, a) => t.length > 1 && a.indexOf(t) === i);
  for (const q of tries) {
    const hits = await searchLoseItFoods(q);
    const top = hits.find(h => !h.recipe) ?? hits[0];
    if (top) return top;
  }
  throw new Error(`Couldn't find “${clean}” in Lose It!`);
}

// Logs one recipe ingredient (already scaled to what's being eaten, metric) to the day's meal: found in Lose It!,
// then converted from grams/millilitres into the food's own unit. Millilitres of a food Lose It! measures by weight
// are taken as grams (like water), which is marked with ≈.
export async function acceptRecipeIngredient(ing: RecipeAmount, date: string, meal: number): Promise<{ day: DiaryDay; logged: Macros & { name: string; label: string } }> {
  if (!(ing.amount > 0)) throw new Error("No amount to add");
  const food = await findFoodByName(ing.name);
  const d = await getLoseItFoodDetails(food);
  const u = d.units ?? "";
  const massG = LOSEIT_MASS_G[u], volMl = LOSEIT_VOLUME_ML[u];
  let quantity: number, unit: "food" | "gram", factor: number, approx = false;
  // A measure left as written (tablespoons, teaspoons by default) goes in as is when the food has that unit.
  const keepUnit = ing.keep ? MEASURE_DEFS.find(m => m.key === ing.keep!.key)?.loseIt : undefined;
  if (ing.keep && keepUnit && u === keepUnit) {
    quantity = ing.keep.quantity; unit = "food"; factor = quantity / d.quantity;
  } else if (ing.unit === "g") {
    if (massG) { quantity = ing.amount / massG; unit = "food"; factor = quantity / d.quantity; }
    else if (d.grams != null && d.grams > 0) { quantity = ing.amount; unit = "gram"; factor = ing.amount / d.grams; }
    else throw new Error(`Lose It! has no weight for ${food.name}, so ${Math.round(ing.amount)} g can't be converted`);
  } else if (ing.unit === "ml") {
    if (volMl) { quantity = ing.amount / volMl; unit = "food"; factor = quantity / d.quantity; }
    else if (d.grams != null && d.grams > 0) { quantity = ing.amount; unit = "gram"; factor = ing.amount / d.grams; approx = true; }
    else throw new Error(`Lose It! has no weight for ${food.name}, so ${Math.round(ing.amount)} ml can't be converted`);
  } else {
    if (massG || volMl) throw new Error(`${food.name} is measured by ${massG ? "weight" : "volume"} in Lose It!, so “${Math.round(ing.amount * 10) / 10} ${ing.countUnit ?? ""}” can't be converted`);
    quantity = ing.amount; unit = "food"; factor = ing.amount / d.quantity;
  }
  quantity = Math.round(quantity * 100) / 100;
  const day = await addLoseItFood(food, date, meal, quantity, unit);
  const s = (v: number | null) => Math.round((v ?? 0) * factor * 10) / 10;
  const shown = `${approx ? "≈ " : ""}${unit === "gram" ? `${Math.round(quantity)} g` : `${quantity} ${d.units ?? "serving"}`}`;
  return { day, logged: { name: food.name, label: shown, kcal: Math.round(s(d.kcal)), proteinG: s(d.proteinG), carbsG: s(d.carbsG), fatG: s(d.fatG) } };
}

// ── Accept one past-dinner item ────────────────────────────────────────────

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
