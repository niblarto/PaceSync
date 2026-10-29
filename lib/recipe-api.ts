import { getDb } from "@/lib/db";

// Recipe ideas for "Create meal", from API Ninjas' recipe API
// (https://api.api-ninjas.com/v3/recipe). The key is saved in Settings →
// Integrations → Coach and never sent back to the browser. Recipes carry no
// nutrition here, so they are inspiration only; the meal's numbers come from
// the Lose It! food history (lib/meal-builder.ts).

const KEY = "api_ninjas_key";
const URL = "https://api.api-ninjas.com/v3/recipe";

// nutrition: API Ninjas' own figures for the dish, e.g. "calories 450, protein 32, carbohydrates 40, fat 18" (whatever it sends).
export interface Recipe { title: string; ingredients: string[]; servings: string | null; instructions: string; nutrition: string | null; kcal: number | null }

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
    const res = await fetch(`${URL}?title=${encodeURIComponent(query.slice(0, 100))}&limit=5`, {
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
    const ing = (i: Ing) => (typeof i === "string" ? i : [i.quantity, i.unit, i.name].filter(v => v != null && v !== "").join(" "));
    const recipes = (Array.isArray(data) ? data : []).filter(r => r.title).map(r => ({
      title: String(r.title).trim(),
      ingredients: (Array.isArray(r.ingredients) ? r.ingredients.map(ing) : String(r.ingredients ?? "").split("|")).map(s => s.trim()).filter(Boolean),
      servings: r.servings ? String(r.servings) : null,
      instructions: (Array.isArray(r.instructions) ? r.instructions.join(" ") : String(r.instructions ?? "")).replace(/\s+/g, " ").trim().slice(0, 900),
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
