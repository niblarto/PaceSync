import { getDb } from "@/lib/db";

// Recipe ideas for "Create meal", from API Ninjas' recipe API
// (https://api.api-ninjas.com/v3/recipe). The key is saved in Settings →
// Integrations → Coach and never sent back to the browser. A recipe's
// ingredients keep their amounts (parsed where possible) so they can be added
// to the Lose It! diary one by one (lib/meal-builder.ts).

const KEY = "api_ninjas_key";
const ENDPOINT = "https://api.api-ninjas.com/v3/recipe";

// One recipe ingredient. quantity/unit are for the whole recipe; null when the source gave no usable amount.
export interface RecipeIngredient { text: string; name: string; quantity: number | null; unit: string | null }

// nutrition: the source's own figures for the dish, e.g. "calories 450, protein 32 g…" (whatever it sends).
// id: FatSecret's recipe id, to fetch the full ingredient list later. servingsN: how many servings the recipe makes.
export interface Recipe {
  id: string | null; title: string; ingredients: RecipeIngredient[]; servings: string | null; servingsN: number | null;
  instructions: string; nutrition: string | null; kcal: number | null;
}

const FRACTIONS: Record<string, number> = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3, "⅛": 0.125 };

// "2", "1.5", "1/2", "1 1/2", "1½", "2-3" (first number) → a number; anything else ("to taste") → null.
export function parseQuantity(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v !== "string") return null;
  let s = v.trim();
  if (!s) return null;
  for (const [k, n] of Object.entries(FRACTIONS)) s = s.replace(k, ` ${n} `);
  s = s.split(/[-–]/)[0].trim();
  let total = 0;
  for (const part of s.split(/\s+/)) {
    const frac = /^(\d+)\/(\d+)$/.exec(part);
    const n = frac ? Number(frac[1]) / Number(frac[2]) : Number(part);
    if (!Number.isFinite(n)) return null;
    total += n;
  }
  return total > 0 ? total : null;
}

export function loadRecipeKey(): string | null {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(KEY) as { value_json: string } | undefined;
    const v = row ? JSON.parse(row.value_json) as string : null;
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

export function saveRecipeKey(key: string | null): void {
  const db = getDb();
  if (!key) db.prepare("DELETE FROM kv_config WHERE key = ?").run(KEY);
  else db.prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(KEY, JSON.stringify(key.trim()));
}

export async function searchRecipes(query: string, key = loadRecipeKey()): Promise<{ ok: true; recipes: Recipe[] } | { ok: false; error: string }> {
  if (!key) return { ok: false, error: "No recipe API key saved (Settings → Integrations → Coach)" };
  try {
    const res = await fetch(`${ENDPOINT}?title=${encodeURIComponent(query.slice(0, 100))}&limit=5`, {
      headers: { "X-Api-Key": key },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, error: "API Ninjas rejected the key" };
    if (res.status === 429) return { ok: false, error: "API Ninjas recipe limit reached" };
    if (!res.ok) {
      const detail = await res.text().then(t => t.replace(/\s+/g, " ").slice(0, 160)).catch(() => "");
      return { ok: false, error: `API Ninjas recipe search failed (${res.status}${detail ? `: ${detail}` : ""})` };
    }
    type Ing = string | { name?: string; quantity?: string | number; unit?: string };
    const data = await res.json() as { title?: string; ingredients?: Ing[] | string; servings?: string; instructions?: string[] | string; nutrition?: Record<string, unknown> }[];
    const ing = (i: Ing): RecipeIngredient => {
      if (typeof i === "string") return { text: i.trim(), name: i.trim(), quantity: null, unit: null };
      const unit = i.unit ? String(i.unit).trim() : null;
      const name = String(i.name ?? "").trim();
      return { text: [i.quantity, unit, name].filter(v => v != null && v !== "").join(" "), name, quantity: parseQuantity(i.quantity), unit: unit || null };
    };
    const recipes = (Array.isArray(data) ? data : []).filter(r => r.title).map(r => ({
      id: null,
      title: String(r.title).trim(),
      ingredients: (Array.isArray(r.ingredients) ? r.ingredients.map(ing) : String(r.ingredients ?? "").split("|").map(s => ing(s))).filter(i => i.text),
      servings: r.servings ? String(r.servings) : null,
      servingsN: parseQuantity(String(r.servings ?? "").match(/[\d./½¼¾]+/)?.[0]),
      instructions: (Array.isArray(r.instructions) ? r.instructions.join(" ") : String(r.instructions ?? "")).replace(/\s+/g, " ").trim().slice(0, 1500),
      nutrition: r.nutrition && typeof r.nutrition === "object"
        ? Object.entries(r.nutrition).filter(([k]) => /^(calories|protein|carbohydrates?|(total_)?fat(_total)?)(_?(g|kcal))?$/i.test(k)).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(", ") || null
        : null,
      kcal: (() => {
        const cal = r.nutrition && typeof r.nutrition === "object" ? Object.entries(r.nutrition).find(([k]) => /^calories/i.test(k)) : undefined;
        const n = cal ? parseFloat(String(cal[1])) : NaN;
        return Number.isFinite(n) ? n : null;
      })(),
    }));
    return { ok: true, recipes };
  } catch (e) {
    return { ok: false, error: e instanceof Error && /timeout|abort/i.test(e.message) ? "API Ninjas recipe search timed out" : "Couldn't reach API Ninjas" };
  }
}
