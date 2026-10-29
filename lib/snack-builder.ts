import { getDb } from "@/lib/db";
import type { Macros, MealItem } from "@/lib/meal-builder";

// "Snack Me!" on the Food diary's Snacks card: snacks you have really eaten (the Snacks entries of your last 720 days
// with food logged, empty days skipped) that would keep the day under its calorie limit, picked at random from all
// the ones that fit. Two kinds: single foods in the portion you usually log, and whole snack sessions from one day.
// Accepted through /api/nutrition/create-meal/accept like the dinner ones.

const SNACK_DAYS = 720;
const MIN_KCAL = 40;      // skips a tea or a coffee
const FOODS_SHOWN = 8;
const SESSIONS_SHOWN = 4;
const SEEN_KEY = "snack_seen";

export interface SnackSuggestion {
  kind: "food" | "day";
  name: string;
  items: MealItem[];
  totals: Macros;
  times: number;   // food: how often it was logged as a snack
  last: string;    // food: the last time; day: the day
}

export interface SnackResult { foods: SnackSuggestion[]; days: SnackSuggestion[]; fitFoods: number; fitDays: number }

const r1 = (n: number) => Math.round(n * 10) / 10;
const shuffle = <T,>(a: T[]): T[] => {
  const out = [...a];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
};

function plural(units: string, n: number): string {
  if (n === 1 || units === "Each" || /s$/i.test(units)) return units;
  return /(sh|ch|x)$/i.test(units) ? `${units}es` : `${units}s`;
}

function loadSeen(): { foods: string[]; days: string[] } {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(SEEN_KEY) as { value_json: string } | undefined;
    const v = row ? JSON.parse(row.value_json) as { foods?: string[]; days?: string[] } : {};
    return { foods: v.foods ?? [], days: v.days ?? [] };
  } catch {
    return { foods: [], days: [] };
  }
}

interface Row { date: string; name: string; brand: string | null; quantity: number; units: string | null; kcal: number; protein_g: number | null; carbs_g: number | null; fat_g: number | null }

function itemOf(r: Row, kcal = r.kcal): MealItem {
  const units = r.units ?? "Serving";
  return {
    name: r.name.trim(), brand: r.brand, amount: r.quantity, units,
    label: units === "Gram" ? `${Math.round(r.quantity)} g` : `${r1(r.quantity)} ${plural(units, r.quantity)}`,
    kcal: Math.round(kcal), proteinG: r1(r.protein_g ?? 0), carbsG: r1(r.carbs_g ?? 0), fatG: r1(r.fat_g ?? 0),
  };
}

const totalsOf = (items: MealItem[]): Macros => ({
  kcal: items.reduce((a, i) => a + i.kcal, 0), proteinG: r1(items.reduce((a, i) => a + i.proteinG, 0)),
  carbsG: r1(items.reduce((a, i) => a + i.carbsG, 0)), fatG: r1(items.reduce((a, i) => a + i.fatG, 0)),
});

// kcalLeft: what is left under the day's calorie limit. today: not included (its snacks are already in what's eaten).
export function snackSuggestions(kcalLeft: number, today: string): SnackResult {
  const rows = getDb().prepare(`
    SELECT date, name, brand, quantity, units, kcal, protein_g, carbs_g, fat_g FROM loseit_food_log
    WHERE date >= (SELECT MIN(date) FROM (SELECT DISTINCT date FROM loseit_food_log ORDER BY date DESC LIMIT ?))
      AND date < ? AND meal = 3 AND kcal > 0 AND quantity > 0
    ORDER BY date DESC, seq
  `).all(SNACK_DAYS, today) as Row[];

  // Single foods: each distinct food in the portion most often logged.
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = `${r.name.trim().toLowerCase()}|${(r.brand ?? "").trim().toLowerCase()}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const foods = new Map<string, SnackSuggestion>();
  groups.forEach((list, key) => {
    const tally = new Map<string, Row[]>();
    for (const r of list) {
      const k = `${r.units ?? ""}|${Math.round(r.quantity * 100)}`;
      tally.set(k, [...(tally.get(k) ?? []), r]);
    }
    const usual = Array.from(tally.values()).sort((a, b) => b.length - a.length)[0];
    const avg = usual.reduce((a, r) => a + r.kcal, 0) / usual.length;
    if (avg < MIN_KCAL || avg > kcalLeft) return;
    const item = itemOf(usual[0], avg);
    foods.set(key, { kind: "food", name: item.name, items: [item], totals: totalsOf([item]), times: list.length, last: list[0].date });
  });

  // Whole snack sessions: a day's snacks together (two or more foods) that fit.
  const days = new Map<string, Row[]>();
  for (const r of rows) days.set(r.date, [...(days.get(r.date) ?? []), r]);
  const sessions: SnackSuggestion[] = [];
  days.forEach((list, date) => {
    const items = list.map(r => itemOf(r));
    const totals = totalsOf(items);
    if (items.length < 2 || totals.kcal > kcalLeft || totals.kcal < MIN_KCAL * 2) return;
    sessions.push({ kind: "day", name: items.map(i => i.name).slice(0, 3).join(", "), items, totals, times: 1, last: date });
  });

  // Random picks from everything that fits, leaving out those shown last time where there are enough others.
  const seen = loadSeen();
  const pick = <T extends SnackSuggestion>(all: T[], keyOf: (s: T) => string, recent: string[], n: number) => {
    const fresh = all.filter(s => !recent.includes(keyOf(s)));
    const pool = fresh.length >= n ? fresh : [...fresh, ...all.filter(s => recent.includes(keyOf(s)))];
    return shuffle(pool).slice(0, n);
  };
  const foodList = Array.from(foods.entries()).map(([key, s]) => ({ ...s, key }));
  const chosenFoods = pick(foodList, s => s.key, seen.foods, FOODS_SHOWN).sort((a, b) => b.totals.kcal - a.totals.kcal);
  const chosenDays = pick(sessions, s => s.last, seen.days, SESSIONS_SHOWN).sort((a, b) => b.totals.kcal - a.totals.kcal);

  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(SEEN_KEY, JSON.stringify({ foods: chosenFoods.map(s => s.key), days: chosenDays.map(s => s.last) }));

  return {
    foods: chosenFoods.map(({ key: _key, ...s }) => s),
    days: chosenDays,
    fitFoods: foods.size, fitDays: sessions.length,
  };
}
