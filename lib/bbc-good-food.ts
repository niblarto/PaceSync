import { getDb } from "@/lib/db";
import { parseQuantity, type Recipe, type RecipeIngredient } from "@/lib/recipe-api";

// BBC Good Food recipes for "Create meal", read directly from bbcgoodfood.com instead of through a paid API.
// Built to stay within the site's robots.txt, which disallows /search*: so there is no searching the site.
// Instead the recipe sitemaps (which robots.txt points to) give the list of recipe URLs, a food is matched
// against the words in those URLs, and only the few recipe pages wanted are read (each carries its recipe as
// schema.org JSON-LD: metric ingredients, per-serving nutrition, servings and method). Pages are read slowly,
// one at a time, with an honest user agent, and each is kept locally (table bgf_recipes) so it is only read once.
// Off until switched on in Settings.

const BASE = "https://www.bbcgoodfood.com";
const UA = "PaceSync personal recipe lookup";
const ENABLED_KEY = "bbc_good_food_enabled";
const INDEX_KEY = "bgf_url_index";
const PAGE_DELAY_MS = 1500;
const INDEX_MAX_AGE_MS = 14 * 24 * 60 * 60_000;
const RECIPE_MAX_AGE_MS = 60 * 24 * 60 * 60_000;
const SITEMAPS_USED = 16; // the latest 16 quarterly recipe sitemaps (about four years)

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export function bgfEnabled(): boolean {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(ENABLED_KEY) as { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) === true : false;
  } catch {
    return false;
  }
}

export function setBgfEnabled(on: boolean): void {
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(ENABLED_KEY, JSON.stringify(on));
}

async function get(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,application/xml" }, signal: AbortSignal.timeout(25_000) });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

// ── The list of recipe URLs ────────────────────────────────────────────────

interface UrlIndex { at: string; urls: string[] }

function loadIndex(): UrlIndex | null {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(INDEX_KEY) as { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) as UrlIndex : null;
  } catch {
    return null;
  }
}

// The free recipe URLs from the recent quarterly sitemaps (the /premium/ ones are behind a paywall). Refreshed every
// two weeks; the first time takes about half a minute, as the sitemaps are read one at a time.
async function recipeUrls(status: (line: string) => void): Promise<string[]> {
  const kept = loadIndex();
  if (kept && Date.now() - Date.parse(kept.at) < INDEX_MAX_AGE_MS && kept.urls.length) return kept.urls;

  status(`${kept ? "Refreshing" : "Building"} the BBC Good Food recipe list${kept ? "" : " (first time only, about half a minute)"}…`);
  const indexXml = await get(`${BASE}/sitemap.xml`);
  const maps = (indexXml?.match(/<loc>[^<]*-recipe\.xml<\/loc>/g) ?? []).map(s => s.replace(/<\/?loc>/g, "")).slice(0, SITEMAPS_USED);
  const urls = new Set<string>();
  for (const m of maps) {
    const xml = await get(m);
    for (const l of xml?.match(/<loc>[^<]*<\/loc>/g) ?? []) {
      const u = l.replace(/<\/?loc>/g, "");
      if (u.startsWith(`${BASE}/recipes/`)) urls.add(u);
    }
    await sleep(800);
  }
  if (!urls.size) return kept?.urls ?? []; // couldn't read them: keep what was there
  const index: UrlIndex = { at: new Date().toISOString(), urls: Array.from(urls) };
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(INDEX_KEY, JSON.stringify(index));
  return index.urls;
}

// ── One recipe page ────────────────────────────────────────────────────────

const UNIT_RE = "kg|g|ml|l|litres?|liters?|tsp|tbsp|cups?|oz|lbs?|pints?|pinch|dash|cloves?|slices?|sprigs?|bunch|cans?|tins?";

// "125g pancetta" → 125 g pancetta; "½ tsp smoked paprika" → 0.5 tsp; "2 eggs beaten" → 2 (a count) eggs beaten; "salt" → no amount.
export function parseIngredientLine(line: string): RecipeIngredient {
  const text = line.replace(/\s+/g, " ").trim();
  const m = new RegExp(`^([\\d½¼¾⅓⅔⅛][\\d\\s/.½¼¾⅓⅔⅛–-]*?)\\s*(${UNIT_RE})?\\b\\.?\\s*(.*)$`, "i").exec(text);
  if (!m) return { text, name: text, quantity: null, unit: null };
  const quantity = parseQuantity(m[1]);
  return { text, name: (m[3] || text).trim(), quantity, unit: quantity != null && m[2] ? m[2].toLowerCase() : null };
}

const number = (v: unknown): number | null => {
  const n = parseFloat(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

interface Parsed { title: string; category: string; ingredients: string[]; yieldN: number | null; yieldText: string | null; instructions: string; kcal: number | null; proteinG: number | null; carbsG: number | null; fatG: number | null }

function parsePage(html: string): Parsed | null {
  for (const block of html.match(/<script[^>]*type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/g) ?? []) {
    let data: unknown;
    try { data = JSON.parse(block.replace(/^<script[^>]*>|<\/script>$/g, "")); } catch { continue; }
    const items = Array.isArray(data) ? data : (data as { "@graph"?: unknown[] })["@graph"] ?? [data];
    for (const it of items as Record<string, unknown>[]) {
      const t = it["@type"];
      if (!(t === "Recipe" || (Array.isArray(t) && t.includes("Recipe")))) continue;
      const nutrition = (it.nutrition ?? {}) as Record<string, unknown>;
      const steps = (Array.isArray(it.recipeInstructions) ? it.recipeInstructions : []) as { text?: string }[];
      const yieldRaw = Array.isArray(it.recipeYield) ? it.recipeYield[0] : it.recipeYield;
      return {
        title: String(it.name ?? "").trim(),
        category: [it.recipeCategory].flat().filter(Boolean).join(", "), // "Side dish, Starter", "Main course, Dinner"
        ingredients: (Array.isArray(it.recipeIngredient) ? it.recipeIngredient : []).map(String),
        yieldN: number(yieldRaw), yieldText: yieldRaw != null ? String(yieldRaw) : null,
        instructions: steps.map((s, i) => `${i + 1}. ${String(s.text ?? "").replace(/<[^>]+>/g, "").trim()}`).filter(s => s.length > 4).join(" ").slice(0, 1500),
        kcal: number(nutrition.calories), proteinG: number(nutrition.proteinContent), carbsG: number(nutrition.carbohydrateContent), fatG: number(nutrition.fatContent),
      };
    }
  }
  return null;
}

// A recipe's own category says what it is for: "Main course, Dinner" is wanted, "Side dish, Starter" or "Dessert" is not.
// A recipe with no category is kept, as there is nothing to say it isn't one.
const isDinner = (category: string | undefined) => !category || /main|dinner|supper|lunch/i.test(category) && !/dessert|cake|bake|breakfast/i.test(category);

function toRecipe(url: string, p: Parsed): Recipe & { url: string; category: string } {
  const per = [p.kcal != null && `calories ${Math.round(p.kcal)}`, p.proteinG != null && `protein ${p.proteinG} g`, p.carbsG != null && `carbohydrates ${p.carbsG} g`, p.fatG != null && `fat ${p.fatG} g`]
    .filter(Boolean).join(", ");
  return {
    id: null, url, category: p.category ?? "", title: p.title, ingredients: p.ingredients.map(parseIngredientLine), servings: p.yieldText, servingsN: p.yieldN,
    instructions: p.instructions, nutrition: per ? `per serving: ${per}` : null, kcal: p.kcal,
  };
}

// The recipe at `url`: from the local copy when it is there and recent, else read from the site (and kept).
export async function bgfRecipe(url: string): Promise<(Recipe & { url: string; category: string }) | null> {
  const db = getDb();
  const row = db.prepare("SELECT fetched_at, json FROM bgf_recipes WHERE url = ?").get(url) as { fetched_at: string; json: string } | undefined;
  if (row && Date.now() - Date.parse(row.fetched_at) < RECIPE_MAX_AGE_MS) {
    try { return toRecipe(url, JSON.parse(row.json) as Parsed); } catch {}
  }
  const html = await get(url);
  const parsed = html ? parsePage(html) : null;
  if (!parsed || !parsed.title || !parsed.ingredients.length) return null;
  db.prepare("INSERT INTO bgf_recipes (url, fetched_at, json) VALUES (?, ?, ?) ON CONFLICT(url) DO UPDATE SET fetched_at = excluded.fetched_at, json = excluded.json")
    .run(url, new Date().toISOString(), JSON.stringify(parsed));
  return toRecipe(url, parsed);
}

// ── Finding recipes ────────────────────────────────────────────────────────

const shuffle = <T,>(a: T[]): T[] => {
  const out = [...a];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
};

// Recipes for each term ("smoked salmon"): the URLs whose words include every word of the term (else its last word,
// "salmon"), a few picked at random from those not shown recently, then read one by one. Only a calorie limit
// and the metric preference are applied by the caller. At most `max` pages are read per search.
export async function bgfSearch(
  terms: string[], recentUrls: Set<string>, status: (line: string) => void, opts: { perTerm?: number; max?: number } = {},
): Promise<{ ok: true; recipes: (Recipe & { url: string; category: string })[] } | { ok: false; error: string }> {
  const urls = await recipeUrls(status);
  if (!urls.length) return { ok: false, error: "Couldn't read BBC Good Food's recipe list" };
  const perTerm = opts.perTerm ?? 2, max = opts.max ?? 8;

  const chosen: string[] = [];
  for (const term of terms) {
    const words = term.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (!words.length) continue;
    const all = (ws: string[]) => urls.filter(u => ws.every(w => u.toLowerCase().includes(w)));
    let matches = all(words);
    if (!matches.length && words.length > 1) matches = all([words[words.length - 1]]);
    const fresh = matches.filter(u => !recentUrls.has(u) && !chosen.includes(u));
    for (const u of shuffle(fresh).slice(0, perTerm)) chosen.push(u);
  }
  if (!chosen.length) return { ok: true, recipes: [] };

  status(`Reading ${Math.min(chosen.length, max)} BBC Good Food recipes…`);
  const recipes: (Recipe & { url: string; category: string })[] = [];
  for (const u of chosen.slice(0, max)) {
    const cached = !!getDb().prepare("SELECT 1 FROM bgf_recipes WHERE url = ?").get(u);
    const r = await bgfRecipe(u);
    if (r && isDinner(r.category)) recipes.push(r);
    if (!cached) await sleep(PAGE_DELAY_MS); // be gentle with the site; recipes already kept locally need no wait
  }
  return { ok: true, recipes };
}
