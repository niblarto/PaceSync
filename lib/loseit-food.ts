import { getDb } from "@/lib/db";
import {
  copyEntry, currentBuild, deleteEntry, fetchDay, fetchMyFoods, getFoodDraft, LoseItAuthError, prepareEntry, saveEntry, searchFoods, summarizeDraft, WEIGHT_G,
  type LoseItEntry,
} from "@/lib/loseit-gwt";
import { downloadExport, parseFoodLogCsv, readZipEntry, singularUnit, type ExportFoodRow } from "@/lib/loseit-export";
import { loadLoseItAccount, loadLoseItSession, withLoseItSession } from "@/lib/loseit-session";
import { sendNtfy } from "@/lib/ntfy";

// Lose It! food diary → loseit_food_log (one row per logged food).
//
// Traffic is kept to a minimum: the 1.6 MB full export is downloaded once,
// for the history import (and again only on a manual "full resync"). After
// that each sync reads just today's diary over RPC (~4.6 KB), plus yesterday
// once on the first sync of a new day to catch late edits. Older days are
// never re-read automatically. Each day read replaces that day's rows, so
// foods deleted in Lose It! disappear here too.

export const MEAL_NAMES = ["Breakfast", "Lunch", "Dinner", "Snacks"] as const;

// FoodMeasure ids → unit names, from the Lose It! web app's own unit table
// (its FoodMeasure enum). Ids not listed here are learned from the export
// (see unitsFor).
const MEASURE_UNITS: Record<number, string> = {
  1: "Teaspoon", 2: "Tablespoon", 3: "Cup", 4: "Piece", 5: "Each", 6: "Ounce", 7: "Pound", 8: "Gram", 9: "Kilogram",
  10: "Fluid Ounce", 11: "Milliliter", 12: "Liter", 13: "Gallon", 14: "Pint", 15: "Quart", 16: "Milligram",
  17: "Microgram", 18: "Intake", 19: "Bottle", 20: "Box", 21: "Can", 22: "Cube", 23: "Jar", 24: "Stick", 25: "Tablet",
  26: "Slice", 27: "Serving", 28: "300 Can", 29: "303 Can", 30: "401 Can", 31: "404 Can", 32: "Ind Package",
  33: "Scoop", 34: "Metric Cup", 35: "Dry Cup", 36: "Imperial Fluid Ounce", 37: "Imperial Gallon",
  38: "Imperial Quart", 39: "Imperial Pint", 40: "Tablespoon", 41: "Dessertspoon", 42: "Pot", 43: "Punnet",
  44: "As Entered", 45: "Container", 46: "Package", 47: "Pouch",
};

// Units that count things; a food measured in one of these is offered in
// that unit first. Anything else (cups, spoons, ounces…) defaults to grams.
const COUNT_UNITS = new Set([4, 5, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 42, 43, 44, 45, 46, 47]);

// FoodMeasurement ordinals in an entry's nutrient map.
const NUTRIENT = { kcal: 0, fat: 3, satFat: 4, cholesterol: 8, sodium: 9, carbs: 10, fiber: 11, sugar: 12, protein: 13 } as const;

const STATE_KEY = "loseit_sync_state";
const MIN_SYNC_INTERVAL_MS = 5 * 60_000;
const ERROR_NOTIFY_INTERVAL_MS = 24 * 60 * 60_000;

interface SyncState {
  importedAt: string | null;
  importedRows: number;
  lastDaySyncAt: string | null;
  yesterdayCheckedFor: string | null; // the "today" on which yesterday was last re-read
  lastError: string | null;
  lastErrorAt: string | null;
  errorNotifiedAt: string | null;
  learnedUnits: Record<string, string>;
  myFoodsAt: string | null; // when the My Foods cache was last downloaded
}

const EMPTY_STATE: SyncState = {
  importedAt: null, importedRows: 0, lastDaySyncAt: null, yesterdayCheckedFor: null,
  lastError: null, lastErrorAt: null, errorNotifiedAt: null, learnedUnits: {}, myFoodsAt: null,
};

function loadState(): SyncState {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(STATE_KEY) as { value_json: string } | undefined;
    if (row) return { ...EMPTY_STATE, ...(JSON.parse(row.value_json) as Partial<SyncState>) };
  } catch {}
  return { ...EMPTY_STATE };
}

function saveState(s: SyncState): void {
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(STATE_KEY, JSON.stringify(s));
}

export function localIsoDate(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function shiftDate(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return localIsoDate(new Date(y, m - 1, d + days));
}

// ── Storage ────────────────────────────────────────────────────────────────

interface FoodRowInput {
  entryId: string | null;
  meal: number;
  name: string;
  brand: string | null;
  icon: string | null;
  quantity: number | null;
  units: string | null;
  kcal: number | null;
  fatG: number | null;
  satFatG: number | null;
  cholesterolMg: number | null;
  sodiumMg: number | null;
  carbsG: number | null;
  fiberG: number | null;
  sugarG: number | null;
  proteinG: number | null;
}

const INSERT_SQL = `
  INSERT INTO loseit_food_log (date, seq, entry_id, meal, name, brand, icon, quantity, units, kcal, fat_g, sat_fat_g,
    cholesterol_mg, sodium_mg, carbs_g, fiber_g, sugar_g, protein_g, source, updated_at)
  VALUES (@date, @seq, @entryId, @meal, @name, @brand, @icon, @quantity, @units, @kcal, @fatG, @satFatG,
    @cholesterolMg, @sodiumMg, @carbsG, @fiberG, @sugarG, @proteinG, @source, @updatedAt)
`;

function replaceDay(date: string, rows: FoodRowInput[], source: "rpc" | "export"): void {
  const db = getDb();
  const del = db.prepare("DELETE FROM loseit_food_log WHERE date = ?");
  const ins = db.prepare(INSERT_SQL);
  const updatedAt = new Date().toISOString();
  db.transaction(() => {
    del.run(date);
    rows.forEach((r, seq) => ins.run({ ...r, date, seq, source, updatedAt }));
  })();
}

function replaceAllFromExport(rows: ExportFoodRow[]): void {
  const db = getDb();
  const ins = db.prepare(INSERT_SQL);
  const updatedAt = new Date().toISOString();
  const seqByDate = new Map<string, number>();
  db.transaction(() => {
    db.prepare("DELETE FROM loseit_food_log").run();
    for (const r of rows) {
      const seq = seqByDate.get(r.date) ?? 0;
      seqByDate.set(r.date, seq + 1);
      ins.run({ ...r, date: r.date, seq, entryId: null, brand: null, source: "export", updatedAt });
    }
  })();
}

// Unit name for an RPC entry's measure id: the known table, else one learned
// earlier, else the unit the export used most recently for the same food.
function unitsFor(e: LoseItEntry, state: SyncState): string | null {
  if (e.measureId === null) return null;
  const known = MEASURE_UNITS[e.measureId] ?? state.learnedUnits[String(e.measureId)];
  if (known) return known;
  const row = getDb().prepare(
    "SELECT units FROM loseit_food_log WHERE name = ? AND source = 'export' AND units IS NOT NULL ORDER BY date DESC LIMIT 1",
  ).get(e.name) as { units: string } | undefined;
  if (!row) return null;
  state.learnedUnits[String(e.measureId)] = singularUnit(row.units);
  return state.learnedUnits[String(e.measureId)];
}

function rowFromEntry(e: LoseItEntry, state: SyncState): FoodRowInput {
  const n = (k: keyof typeof NUTRIENT) => {
    const v = e.nutrients[NUTRIENT[k]];
    return typeof v === "number" && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
  };
  return {
    entryId: e.entryId || null,
    meal: e.meal,
    name: e.name,
    brand: e.brand,
    icon: e.icon,
    quantity: e.quantity,
    units: unitsFor(e, state),
    kcal: n("kcal"), fatG: n("fat"), satFatG: n("satFat"), cholesterolMg: n("cholesterol"), sodiumMg: n("sodium"),
    carbsG: n("carbs"), fiberG: n("fiber"), sugarG: n("sugar"), proteinG: n("protein"),
  };
}

// ── Sync ───────────────────────────────────────────────────────────────────

async function syncDay(date: string, state: SyncState): Promise<number> {
  const entries = await withLoseItSession(who => fetchDay(who, date));
  replaceDay(date, entries.map(e => rowFromEntry(e, state)), "rpc");
  return entries.length;
}

async function importHistory(state: SyncState): Promise<number> {
  const csv = await withLoseItSession(async who => {
    const zip = await downloadExport(who.cookie);
    const file = readZipEntry(zip, "food-logs.csv");
    if (!file) throw new Error("export has no food-logs.csv");
    return file.toString("utf8");
  });
  const rows = parseFoodLogCsv(csv);
  replaceAllFromExport(rows);
  state.importedAt = new Date().toISOString();
  state.importedRows = rows.length;
  return rows.length;
}

export interface LoseItSyncResult {
  status: "synced" | "fresh" | "not-connected" | "error";
  imported?: number;
  days?: Record<string, number>; // date → entries read
  error?: string;
}

let running: Promise<LoseItSyncResult> | null = null;

// force: skip the 5-minute throttle. full: re-download the whole export.
export function syncLoseIt(opts: { force?: boolean; full?: boolean } = {}): Promise<LoseItSyncResult> {
  if (!running) running = runSync(opts).finally(() => { running = null; });
  return running;
}

async function runSync({ force = false, full = false }: { force?: boolean; full?: boolean }): Promise<LoseItSyncResult> {
  if (!loadLoseItAccount()) return { status: "not-connected" };
  const state = loadState();
  const today = localIsoDate();
  const needImport = full || !state.importedAt;
  if (!needImport && !force && state.lastDaySyncAt && Date.now() - Date.parse(state.lastDaySyncAt) < MIN_SYNC_INTERVAL_MS) {
    return { status: "fresh" };
  }

  const result: LoseItSyncResult = { status: "synced", days: {} };
  try {
    if (needImport) result.imported = await importHistory(state);
    // The export's numbers are slightly lossy (see lib/loseit-export.ts), so
    // re-read today and yesterday over RPC right after an import as well.
    if (needImport || state.yesterdayCheckedFor !== today) {
      const y = shiftDate(today, -1);
      result.days![y] = await syncDay(y, state);
      state.yesterdayCheckedFor = today;
    }
    result.days![today] = await syncDay(today, state);
    state.lastDaySyncAt = new Date().toISOString();
    state.lastError = null;
    state.lastErrorAt = null;
    saveState(state);
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    state.lastError = msg;
    state.lastErrorAt = new Date().toISOString();
    const notifyDue = !state.errorNotifiedAt || Date.now() - Date.parse(state.errorNotifiedAt) > ERROR_NOTIFY_INTERVAL_MS;
    if (notifyDue) {
      state.errorNotifiedAt = state.lastErrorAt;
      const hint = e instanceof LoseItAuthError ? "Check the Lose It! login in Settings." : "The food diary keeps its last good data.";
      await sendNtfy(`${msg}\n${hint}`, { title: "Lose It! sync failing", tags: "warning" }).catch(() => false);
    }
    saveState(state);
    return { status: "error", error: msg };
  }
}

// ── Reads ──────────────────────────────────────────────────────────────────

interface DbRow {
  date: string; seq: number; entry_id: string | null; meal: number; name: string; brand: string | null; icon: string | null;
  quantity: number | null; units: string | null; kcal: number | null; fat_g: number | null; sat_fat_g: number | null;
  cholesterol_mg: number | null; sodium_mg: number | null; carbs_g: number | null; fiber_g: number | null;
  sugar_g: number | null; protein_g: number | null; source: string; updated_at: string;
}

export interface DiaryFood {
  entryId: string | null; // set for days read over RPC; needed to remove the food
  name: string;
  brand: string | null;
  icon: string | null;
  quantity: number | null;
  units: string | null;
  kcal: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  satFatG: number | null;
  sugarG: number | null;
  fiberG: number | null;
  sodiumMg: number | null;
  cholesterolMg: number | null;
}

export interface DiaryTotals { kcal: number; proteinG: number; carbsG: number; fatG: number }

export interface DiaryDay {
  date: string;
  meals: { meal: number; name: string; foods: DiaryFood[]; totals: DiaryTotals }[];
  totals: DiaryTotals;
  source: "rpc" | "export" | null;
  updatedAt: string | null;
}

function totalsOf(foods: DiaryFood[]): DiaryTotals {
  const sum = (f: (x: DiaryFood) => number | null) => Math.round(foods.reduce((a, x) => a + (f(x) ?? 0), 0) * 10) / 10;
  return { kcal: sum(x => x.kcal), proteinG: sum(x => x.proteinG), carbsG: sum(x => x.carbsG), fatG: sum(x => x.fatG) };
}

export function getDiaryDay(date: string): DiaryDay {
  const rows = getDb().prepare("SELECT * FROM loseit_food_log WHERE date = ? ORDER BY meal, seq").all(date) as DbRow[];
  const foods = rows.map(r => ({
    meal: r.meal,
    food: {
      entryId: r.source === "rpc" ? r.entry_id : null, name: r.name, brand: r.brand, icon: r.icon, quantity: r.quantity, units: r.units, kcal: r.kcal,
      proteinG: r.protein_g, carbsG: r.carbs_g, fatG: r.fat_g, satFatG: r.sat_fat_g, sugarG: r.sugar_g,
      fiberG: r.fiber_g, sodiumMg: r.sodium_mg, cholesterolMg: r.cholesterol_mg,
    } as DiaryFood,
  }));
  const meals = MEAL_NAMES.map((name, meal) => {
    const list = foods.filter(f => f.meal === meal).map(f => f.food);
    return { meal, name, foods: list, totals: totalsOf(list) };
  }).filter(m => m.foods.length > 0);
  return {
    date,
    meals,
    totals: totalsOf(foods.map(f => f.food)),
    source: rows.length ? (rows[0].source as "rpc" | "export") : null,
    updatedAt: rows.length ? rows[0].updated_at : null,
  };
}

export interface LoseItStatus {
  connected: boolean;
  email: string | null;
  sessionExpiresAt: string | null;
  importedAt: string | null;
  importedRows: number;
  lastDaySyncAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  foods: number;
  firstDate: string | null;
  lastDate: string | null;
}

export function getLoseItStatus(): LoseItStatus {
  const account = loadLoseItAccount();
  const session = loadLoseItSession();
  const state = loadState();
  const agg = getDb().prepare("SELECT COUNT(*) AS n, MIN(date) AS first, MAX(date) AS last FROM loseit_food_log")
    .get() as { n: number; first: string | null; last: string | null };
  return {
    connected: !!account,
    email: account?.email ?? null,
    sessionExpiresAt: session?.expiresAt ?? null,
    importedAt: state.importedAt,
    importedRows: state.importedRows,
    lastDaySyncAt: state.lastDaySyncAt,
    lastError: state.lastError,
    lastErrorAt: state.lastErrorAt,
    foods: agg.n,
    firstDate: agg.first,
    lastDate: agg.last,
  };
}

// Forgetting the account also forgets sync progress, so reconnecting
// (possibly to a different account) starts with a fresh import.
export function resetLoseItSyncState(): void {
  getDb().prepare("DELETE FROM kv_config WHERE key = ?").run(STATE_KEY);
}

// ── Search and add (web Nutrition page) ────────────────────────────────────
// Each add is: search → draft (Lose It! fills in the food's default amount
// and nutrients) → save the draft with the chosen date, meal and amount. The
// day is then re-read so the diary shows exactly what Lose It! stored.

export interface FoodRef { pk: string; name: string; locale: string | null } // pk: 32 hex chars

export interface FoodSearchResult extends FoodRef {
  brand: string | null;
  icon: string | null;
  mine: boolean;       // in the account's My Foods
  timesLogged: number; // how often it appears in the stored diary (My Foods only)
}

export interface FoodDetails {
  quantity: number;  // default amount, in `units`
  units: string | null;
  grams: number | null; // weight of the default amount, when Lose It! knows it (allows logging in grams)
  preferGrams: boolean; // the food's unit is a cup/spoon/ounce-type measure rather than a count
  kcal: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
}

const toHex = (bytes: number[]) => bytes.map(b => (b & 0xff).toString(16).padStart(2, "0")).join("");

function fromHex(pk: string): number[] {
  if (!/^[0-9a-f]{32}$/i.test(pk)) throw new Error("bad food key");
  return Array.from({ length: 16 }, (_, i) => {
    const b = parseInt(pk.slice(i * 2, i * 2 + 2), 16);
    return b > 127 ? b - 256 : b;
  });
}

const MY_FOODS_MAX_AGE_MS = 24 * 60 * 60_000;

// Downloads My Foods (~45 KB) when the cache is empty or a day old. Only
// called from a search, so on days nothing is searched it costs nothing.
async function ensureMyFoods(): Promise<void> {
  const state = loadState();
  const fresh = state.myFoodsAt && Date.now() - Date.parse(state.myFoodsAt) < MY_FOODS_MAX_AGE_MS;
  const count = (getDb().prepare("SELECT COUNT(*) AS n FROM loseit_my_foods").get() as { n: number }).n;
  if (fresh && count > 0) return;
  const foods = await withLoseItSession(fetchMyFoods);
  const db = getDb();
  const ins = db.prepare("INSERT OR REPLACE INTO loseit_my_foods (pk, name, brand, icon, locale) VALUES (?, ?, ?, ?, ?)");
  db.transaction(() => {
    db.prepare("DELETE FROM loseit_my_foods").run();
    for (const f of foods) ins.run(toHex(f.pk), f.name, f.brand, f.icon, f.locale);
  })();
  const latest = loadState();
  latest.myFoodsAt = new Date().toISOString();
  saveState(latest);
}

// My Foods whose name/brand contains every word of the query, most often
// eaten first (counted from the stored diary). Editing a recipe in Lose It!
// keeps the old versions under the same name; the lists come back in
// creation order (rowid keeps it), so for a repeated name + brand only the
// last — newest — version is shown.
function searchMyFoods(query: string): FoodSearchResult[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = getDb().prepare("SELECT pk, name, brand, icon, locale FROM loseit_my_foods ORDER BY rowid").all() as
    { pk: string; name: string; brand: string | null; icon: string | null; locale: string | null }[];
  const newest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const text = `${r.name} ${r.brand ?? ""}`.toLowerCase();
    if (words.every(w => text.includes(w))) newest.set(`${r.name.trim().toLowerCase()}|${(r.brand ?? "").trim().toLowerCase()}`, r);
  }
  const matches = Array.from(newest.values());
  if (!matches.length) return [];
  const counts = new Map<string, number>();
  for (const c of getDb().prepare("SELECT LOWER(TRIM(name)) AS name, COUNT(*) AS n FROM loseit_food_log GROUP BY LOWER(TRIM(name))").all() as { name: string; n: number }[]) {
    counts.set(c.name, c.n);
  }
  return matches
    .map(r => ({ ...r, mine: true, timesLogged: counts.get(r.name.trim().toLowerCase()) ?? 0 }))
    .sort((a, b) => b.timesLogged - a.timesLogged || a.name.localeCompare(b.name));
}

// My Foods matches first, then Lose It!'s database results not already listed.
export async function searchLoseItFoods(query: string): Promise<FoodSearchResult[]> {
  // Settled straight away so a failure can't surface as an unhandled rejection.
  const remote = withLoseItSession(who => searchFoods(who, query))
    .then(foods => ({ foods, error: null }), (error: unknown) => ({ foods: [], error }));
  // A failed refresh still searches the old cache.
  const mineResult = await ensureMyFoods().then(() => searchMyFoods(query), () => searchMyFoods(query));
  const { foods, error } = await remote;
  if (error && !mineResult.length) throw error;
  const seen = new Set(mineResult.map(f => f.pk));
  const others = foods
    .map(f => ({ pk: toHex(f.pk), name: f.name, brand: f.brand, icon: f.icon, locale: f.locale, mine: false, timesLogged: 0 }))
    .filter(f => !seen.has(f.pk));
  return [...mineResult, ...others];
}

function unitName(measureId: number | null): string | null {
  if (measureId === null) return null;
  return MEASURE_UNITS[measureId] ?? loadState().learnedUnits[String(measureId)] ?? null;
}

export async function getLoseItFoodDetails(food: FoodRef): Promise<FoodDetails> {
  const draft = await withLoseItSession(who => getFoodDraft(who, { pk: fromHex(food.pk), name: food.name, locale: food.locale }));
  const d = summarizeDraft(draft);
  const n = (k: keyof typeof NUTRIENT) => (typeof d.nutrients[NUTRIENT[k]] === "number" ? Math.round(d.nutrients[NUTRIENT[k]] * 10) / 10 : null);
  const grams = d.nutrients[WEIGHT_G] > 0 ? Math.round(d.nutrients[WEIGHT_G] * 10) / 10 : null;
  return {
    quantity: d.quantity, units: unitName(d.measureId), grams,
    preferGrams: grams !== null && d.measureId !== 8 && !(d.measureId !== null && COUNT_UNITS.has(d.measureId)),
    kcal: n("kcal"), proteinG: n("protein"), carbsG: n("carbs"), fatG: n("fat"),
  };
}

// Re-reads one day from Lose It! into loseit_food_log.
async function refreshDay(date: string): Promise<void> {
  const state = loadState();
  await syncDay(date, state);
  saveState(state);
}

export async function addLoseItFood(
  food: FoodRef & { brand?: string | null; icon?: string | null }, date: string, meal: number, quantity: number,
  unit: "food" | "gram" = "food",
): Promise<DiaryDay> {
  if (!(meal >= 0 && meal <= 3)) throw new Error("meal must be 0-3");
  if (!(quantity > 0 && quantity < 100_000)) throw new Error("quantity must be positive");
  await withLoseItSession(async who => {
    const draft = await getFoodDraft(who, { pk: fromHex(food.pk), name: food.name, locale: food.locale });
    await saveEntry(who, prepareEntry(await currentBuild(who.cookie), draft, date, meal, quantity, unit));
  });
  // Lose It! now counts it as one of My Foods; mirror that without re-downloading the list.
  getDb().prepare("INSERT OR IGNORE INTO loseit_my_foods (pk, name, brand, icon, locale) VALUES (?, ?, ?, ?, ?)")
    .run(food.pk.toLowerCase(), food.name, food.brand ?? null, food.icon ?? null, food.locale);
  await refreshDay(date);
  return getDiaryDay(date);
}

// Removes a food from the Lose It! diary. The entry is re-read from Lose It!
// first, since deleting means sending the whole entry back.
export async function removeLoseItFood(date: string, entryId: string): Promise<DiaryDay> {
  await withLoseItSession(async who => {
    const entry = (await fetchDay(who, date)).find(e => e.entryId === entryId);
    if (!entry) throw new Error("That food is no longer in the Lose It! diary");
    await deleteEntry(who, entry.node);
  });
  await refreshDay(date);
  return getDiaryDay(date);
}

// ── Copy to today (web Nutrition page's right-click menu) ──────────────────
// Copies foods as they were logged — same food, amount and nutrients — into
// today's diary. The source day is re-read from Lose It! first, since a copy
// is made from the full stored entry. Foods from days that only came from
// the export have no entry id, so those are matched by meal, name and calories.

export interface CopyItem { entryId: string | null; name: string; meal: number; kcal: number | null }

export async function copyLoseItFoods(
  fromDate: string, what: { meal: number } | { items: CopyItem[]; toMeal: number },
): Promise<{ copied: number; toDate: string; day: DiaryDay }> {
  const toDate = localIsoDate();
  let copied = 0;
  await withLoseItSession(async who => {
    copied = 0;
    const entries = await fetchDay(who, fromDate);
    const picks: { entry: LoseItEntry; meal: number }[] = [];
    if ("meal" in what) {
      for (const entry of entries) if (entry.meal === what.meal) picks.push({ entry, meal: what.meal });
    } else {
      const used = new Set<LoseItEntry>();
      for (const it of what.items) {
        const entry = entries.find(e => !used.has(e) && (it.entryId
          ? e.entryId === it.entryId
          : e.meal === it.meal && e.name === it.name.trim() && Math.abs((e.nutrients[NUTRIENT.kcal] ?? 0) - (it.kcal ?? 0)) <= 1));
        if (!entry) throw new Error(`${it.name} is no longer in that day's Lose It! diary`);
        used.add(entry);
        picks.push({ entry, meal: what.toMeal });
      }
    }
    if (!picks.length) throw new Error("Nothing to copy");
    const build = await currentBuild(who.cookie);
    for (const p of picks) {
      await saveEntry(who, copyEntry(build, p.entry.node, toDate, p.meal));
      copied++;
    }
  });
  await refreshDay(toDate);
  return { copied, toDate, day: getDiaryDay(toDate) };
}
