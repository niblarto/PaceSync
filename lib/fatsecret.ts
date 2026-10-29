import { getDb } from "@/lib/db";
import { parseQuantity, type Recipe, type RecipeIngredient } from "@/lib/recipe-api";

// Recipe ideas for "Create meal" from the FatSecret Platform API
// (https://platform.fatsecret.com/docs/guides). OAuth2 client credentials; the
// client id/secret are saved in Settings → Integrations → Coach and never sent
// back to the browser. FatSecret only hands out tokens to IP addresses
// whitelisted for the app in its dashboard (the Pi's public IP). Search
// results carry per-serving calories and macros, but like the other recipe
// source they are inspiration only: the meal's numbers come from the Lose It!
// history (lib/meal-builder.ts).

const KEY = "fatsecret_credentials";
const TOKEN_URL = "https://oauth.fatsecret.com/connect/token";
const SEARCH_URL = "https://platform.fatsecret.com/rest/recipes/search/v3";

interface Credentials { id: string; secret: string }

export function loadFatSecret(): Credentials | null {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(KEY) as { value_json: string } | undefined;
    const v = row ? JSON.parse(row.value_json) as Credentials : null;
    return v?.id && v?.secret ? v : null;
  } catch {
    return null;
  }
}

export function saveFatSecret(c: Credentials | null): void {
  const db = getDb();
  tokenCache = null;
  if (!c) db.prepare("DELETE FROM kv_config WHERE key = ?").run(KEY);
  else db.prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(KEY, JSON.stringify({ id: c.id.trim(), secret: c.secret.trim() }));
}

let tokenCache: { token: string; id: string; expires: number } | null = null;

async function token(c: Credentials): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  if (tokenCache && tokenCache.id === c.id && Date.now() < tokenCache.expires) return { ok: true, token: tokenCache.token };
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`${c.id}:${c.secret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials&scope=basic",
      signal: AbortSignal.timeout(20_000),
    });
    const data = await res.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !data.access_token) {
      return { ok: false, error: res.status === 400 || res.status === 401
        ? `FatSecret rejected the credentials${data.error_description ? ` (${data.error_description})` : ""}` : `FatSecret token request failed (${res.status})` };
    }
    tokenCache = { token: data.access_token, id: c.id, expires: Date.now() + ((data.expires_in ?? 3600) - 300) * 1000 };
    return { ok: true, token: data.access_token };
  } catch (e) {
    return { ok: false, error: e instanceof Error && /timeout|abort/i.test(e.message) ? "FatSecret timed out" : "Couldn't reach FatSecret" };
  }
}

type SearchOpts = { kcalFrom?: number; kcalTo?: number; region?: string; page?: number };
type SearchOut = { ok: true; recipes: Recipe[] } | { ok: false; error: string; soft?: boolean };

// The region filter ("GB") is a Premier feature; once FatSecret refuses it, stop asking until the server restarts.
let regionRefused = false;

// Recipes matching `query`, optionally within a per-serving calorie range, preferring a region's recipes
// (UK ones use metric measures) and starting from a later page for variety. Falls back to a plain search
// when the region isn't allowed on this plan, or the page is past the end.
export async function searchFatSecret(query: string, opts: SearchOpts = {}, creds = loadFatSecret()): Promise<SearchOut> {
  let r = await searchOnce(query, { ...opts, region: regionRefused ? undefined : opts.region }, creds);
  if (!r.ok && r.soft && opts.region && !regionRefused) {
    regionRefused = true;
    r = await searchOnce(query, { ...opts, region: undefined }, creds);
  }
  if (r.ok && r.recipes.length === 0 && (opts.page ?? 0) > 0) r = await searchOnce(query, { ...opts, page: 0, region: regionRefused ? undefined : opts.region }, creds);
  return r;
}

async function searchOnce(query: string, opts: SearchOpts, creds: Credentials | null): Promise<SearchOut> {
  if (!creds) return { ok: false, error: "No FatSecret credentials saved (Settings → Integrations → Coach)" };
  const t = await token(creds);
  if (!t.ok) return t;
  const p = new URLSearchParams({ search_expression: query.slice(0, 100), max_results: "10", format: "json" });
  if (opts.kcalFrom) p.set("calories.from", String(Math.round(opts.kcalFrom)));
  if (opts.kcalTo) p.set("calories.to", String(Math.round(opts.kcalTo)));
  if (opts.region) p.set("region", opts.region);
  if (opts.page) p.set("page_number", String(opts.page));
  try {
    const res = await fetch(`${SEARCH_URL}?${p}`, { headers: { Authorization: `Bearer ${t.token}` }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { ok: false, error: `FatSecret recipe search failed (${res.status})`, soft: true };
    const data = await res.json() as {
      error?: { code?: number; message?: string };
      recipes?: { recipe?: Raw | Raw[] };
    };
    if (data.error) {
      // Code 21 = "Invalid IP address detected": the Pi's IP isn't whitelisted for this app.
      return data.error.code === 21
        ? { ok: false, error: "FatSecret blocked this IP address — whitelist the Pi's public IP in your FatSecret app settings" }
        : { ok: false, error: `FatSecret: ${data.error.message ?? "error"}`, soft: true };
    }
    const list = data.recipes?.recipe ? (Array.isArray(data.recipes.recipe) ? data.recipes.recipe : [data.recipes.recipe]) : [];
    const recipes = list.filter(r => r.recipe_name).map(r => {
      const ing = r.recipe_ingredients?.ingredient;
      const n = r.recipe_nutrition;
      return {
        id: r.recipe_id != null ? String(r.recipe_id) : null,
        title: String(r.recipe_name).trim(),
        // Names only here; getFatSecretRecipe fills in the amounts.
        ingredients: (Array.isArray(ing) ? ing : ing ? [ing] : []).map(String).map(s => s.trim()).filter(Boolean)
          .map((s): RecipeIngredient => ({ text: s, name: s, quantity: null, unit: null })),
        servings: null,
        servingsN: null,
        instructions: String(r.recipe_description ?? "").replace(/\s+/g, " ").trim().slice(0, 400),
        nutrition: n ? `per serving: calories ${n.calories}, protein ${n.protein} g, carbohydrates ${n.carbohydrate} g, fat ${n.fat} g` : null,
        kcal: n && Number.isFinite(Number(n.calories)) ? Number(n.calories) : null,
      };
    });
    return { ok: true, recipes };
  } catch (e) {
    return { ok: false, error: e instanceof Error && /timeout|abort/i.test(e.message) ? "FatSecret timed out" : "Couldn't reach FatSecret" };
  }
}

// One recipe in full (recipe.get v2): its ingredients with amounts, how many servings it makes, and its method.
export async function getFatSecretRecipe(
  id: string, creds = loadFatSecret(),
): Promise<{ ingredients: RecipeIngredient[]; servingsN: number | null; instructions: string } | null> {
  if (!creds) return null;
  const t = await token(creds);
  if (!t.ok) return null;
  try {
    const res = await fetch(`https://platform.fatsecret.com/rest/recipe/v2?${new URLSearchParams({ recipe_id: id, format: "json" })}`, {
      headers: { Authorization: `Bearer ${t.token}` }, signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { error?: unknown; recipe?: FullRecipe };
    const r = data.recipe;
    if (data.error || !r) return null;
    const list = <T,>(v: T | T[] | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
    const ingredients = list(r.ingredients?.ingredient).map((i): RecipeIngredient => {
      const unit = i.measurement_description ? String(i.measurement_description).trim() : null;
      const name = String(i.food_name ?? "").trim();
      return { text: String(i.ingredient_description ?? "").trim() || name, name, quantity: parseQuantity(i.number_of_units), unit };
    }).filter(i => i.name);
    const steps = list(r.directions?.direction).map(d => String(d.direction_description ?? "").trim()).filter(Boolean);
    const n = parseQuantity(r.number_of_servings);
    return { ingredients, servingsN: n, instructions: steps.map((s, i) => `${i + 1}. ${s}`).join(" ").slice(0, 1500) };
  } catch {
    return null;
  }
}

interface FullRecipe {
  number_of_servings?: string | number;
  ingredients?: { ingredient?: FullIng | FullIng[] };
  directions?: { direction?: { direction_description?: string } | { direction_description?: string }[] };
}
interface FullIng { food_name?: string; ingredient_description?: string; measurement_description?: string; number_of_units?: string | number }

interface Raw {
  recipe_id?: string | number;
  recipe_name?: string; recipe_description?: string;
  recipe_nutrition?: { calories?: string | number; protein?: string | number; carbohydrate?: string | number; fat?: string | number };
  recipe_ingredients?: { ingredient?: string | string[] };
}
