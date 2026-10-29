import { getDb } from "@/lib/db";
import type { Recipe } from "@/lib/recipe-api";

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

// Recipes matching `query`, optionally within a per-serving calorie range.
export async function searchFatSecret(
  query: string, opts: { kcalFrom?: number; kcalTo?: number } = {}, creds = loadFatSecret(),
): Promise<{ ok: true; recipes: Recipe[] } | { ok: false; error: string }> {
  if (!creds) return { ok: false, error: "No FatSecret credentials saved (Settings → Integrations → Coach)" };
  const t = await token(creds);
  if (!t.ok) return t;
  const p = new URLSearchParams({ search_expression: query.slice(0, 100), max_results: "5", format: "json" });
  if (opts.kcalFrom) p.set("calories.from", String(Math.round(opts.kcalFrom)));
  if (opts.kcalTo) p.set("calories.to", String(Math.round(opts.kcalTo)));
  try {
    const res = await fetch(`${SEARCH_URL}?${p}`, { headers: { Authorization: `Bearer ${t.token}` }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { ok: false, error: `FatSecret recipe search failed (${res.status})` };
    const data = await res.json() as {
      error?: { code?: number; message?: string };
      recipes?: { recipe?: Raw | Raw[] };
    };
    if (data.error) {
      // Code 21 = "Invalid IP address detected": the Pi's IP isn't whitelisted for this app.
      return { ok: false, error: data.error.code === 21 ? "FatSecret blocked this IP address — whitelist the Pi's public IP in your FatSecret app settings" : `FatSecret: ${data.error.message ?? "error"}` };
    }
    const list = data.recipes?.recipe ? (Array.isArray(data.recipes.recipe) ? data.recipes.recipe : [data.recipes.recipe]) : [];
    const recipes = list.filter(r => r.recipe_name).map(r => {
      const ing = r.recipe_ingredients?.ingredient;
      const n = r.recipe_nutrition;
      return {
        title: String(r.recipe_name).trim(),
        ingredients: (Array.isArray(ing) ? ing : ing ? [ing] : []).map(String).map(s => s.trim()).filter(Boolean),
        servings: null,
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

interface Raw {
  recipe_name?: string; recipe_description?: string;
  recipe_nutrition?: { calories?: string | number; protein?: string | number; carbohydrate?: string | number; fat?: string | number };
  recipe_ingredients?: { ingredient?: string | string[] };
}
