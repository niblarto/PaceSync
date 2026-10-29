import { getDb } from "@/lib/db";
import {
  copyEntry, currentBuild, deleteEntry, moveEntry, fetchDay, fetchGoals, fetchMyFoods, getFoodDraft, LoseItAuthError, prepareEntry, rescaleEntry, saveEntry, searchFoods, summarizeDraft, WEIGHT_G,
  type LoseItEntry, type LoseItGoals,
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
  // Whole meals that a day's read no longer shows, by date: how many separate syncs have seen them missing, and
  // whether it has been asked if they were deleted (see syncDay).
  missingMeals: Record<string, { meals: number[]; checks: number; lastAt: string; alerted: boolean }>;
}

const EMPTY_STATE: SyncState = {
  importedAt: null, importedRows: 0, lastDaySyncAt: null, yesterdayCheckedFor: null,
  lastError: null, lastErrorAt: null, errorNotifiedAt: null, learnedUnits: {}, myFoodsAt: null, missingMeals: {},
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

async function syncDay(date: string, state: SyncState, expectFewer = false): Promise<number> {
  const stored = (getDb().prepare("SELECT COUNT(*) AS n FROM loseit_food_log WHERE date = ? AND source = 'rpc'").get(date) as { n: number }).n;
  let entries = await withLoseItSession(who => fetchDay(who, date));
  // Twice, Lose It! answered with only part of a day (the meals before dinner)
  // that it returned in full seconds later. A read that shows fewer foods than
  // we hold is therefore read again (up to twice more) before a deletion is
  // believed; any read with at least as many wins.
  for (let attempt = 1; attempt <= 2 && stored > 0 && entries.length < stored && !expectFewer; attempt++) {
    console.warn(`[loseit] ${date}: read ${entries.length} foods, ${stored} stored; re-reading (${attempt}/2)`);
    await new Promise(r => setTimeout(r, 3000));
    const again = await withLoseItSession(who => fetchDay(who, date));
    if (again.length >= entries.length) entries = again;
  }
  // Lose It! has answered with only part of a day (breakfast alone, or the meals before dinner) several times in a
  // row, even right after the server restarted, and the whole stored day was then replaced by it. Deleting a whole
  // meal is rare, so a read that no longer shows a meal we hold is not believed: that meal's stored foods are kept
  // (the other meals still update). If separate syncs, at least MISSING_CHECK_GAP_MS apart, see it missing three
  // times, nothing is deleted yet: a notification and a banner on the diary ask for confirmation
  // (resolveMissingMeals). A meal that comes back clears the check. A deletion made through PaceSync (expectFewer) is
  // believed straight away.
  const missing = state.missingMeals ?? (state.missingMeals = {});
  const readMeals = new Set(entries.map(e => e.meal));
  const heldMeals = (getDb().prepare("SELECT DISTINCT meal FROM loseit_food_log WHERE date = ? AND source = 'rpc' ORDER BY meal").all(date) as { meal: number }[])
    .map(r => r.meal).filter(m => !readMeals.has(m));
  if (!expectFewer && stored > 0 && heldMeals.length > 0) {
    const m = missing[date];
    const same = !!m && m.meals.length === heldMeals.length && m.meals.every((x, i) => x === heldMeals[i]);
    const now = Date.now();
    if (!same) missing[date] = { meals: heldMeals, checks: 1, lastAt: new Date(now).toISOString(), alerted: false };
    else if (now - Date.parse(m.lastAt) >= MISSING_CHECK_GAP_MS) { m.checks++; m.lastAt = new Date(now).toISOString(); }
    const c = missing[date];
    console.warn(`[loseit] ${date}: ${heldMeals.map(x => MEAL_NAMES[x]).join(", ")} missing from this read (check ${c.checks}/${MISSING_CHECKS}); keeping the stored foods`);
    if (c.checks >= MISSING_CHECKS && !c.alerted) {
      c.alerted = true;
      const names = heldMeals.map(x => MEAL_NAMES[x]).join(" and ");
      await sendNtfy(`Lose It! no longer shows ${names} for ${date}, ${MISSING_CHECKS} checks in a row. Open the Nutrition page and confirm whether it was deleted.`,
        { title: "Lose It! meal missing", tags: "warning" }).catch(() => false);
    }
    // Rows of the missing meals stay as they were; everything else follows this read.
    const kept = (getDb().prepare("SELECT * FROM loseit_food_log WHERE date = ? AND source = 'rpc' AND meal IN (" + heldMeals.join(",") + ") ORDER BY meal, seq").all(date) as DbRow[])
      .map((r): FoodRowInput => ({
        entryId: r.entry_id, meal: r.meal, name: r.name, brand: r.brand, icon: r.icon, quantity: r.quantity, units: r.units, kcal: r.kcal,
        fatG: r.fat_g, satFatG: r.sat_fat_g, cholesterolMg: r.cholesterol_mg, sodiumMg: r.sodium_mg, carbsG: r.carbs_g, fiberG: r.fiber_g,
        sugarG: r.sugar_g, proteinG: r.protein_g,
      }));
    const merged = [...entries.map(e => rowFromEntry(e, state)), ...kept].map((r, i) => ({ r, i })).sort((a, b) => a.r.meal - b.r.meal || a.i - b.i).map(x => x.r);
    replaceDay(date, merged, "rpc");
    return merged.length;
  }
  delete missing[date];
  if (stored !== entries.length) console.warn(`[loseit] ${date}: ${stored} → ${entries.length} foods`);
  replaceDay(date, entries.map(e => rowFromEntry(e, state)), "rpc");
  return entries.length;
}

const MISSING_CHECKS = 3;
const MISSING_CHECK_GAP_MS = 4 * 60_000;

// The meals of a day that Lose It! no longer shows, once checked often enough to ask: { meals: [{ meal, name, foods }] }.
export function pendingMealDeletion(date: string): { meals: { meal: number; name: string; foods: number }[] } | null {
  const m = loadState().missingMeals?.[date];
  if (!m?.alerted) return null;
  const counts = getDb().prepare("SELECT meal, COUNT(*) AS n FROM loseit_food_log WHERE date = ? AND source = 'rpc' GROUP BY meal").all(date) as { meal: number; n: number }[];
  const meals = m.meals.map(meal => ({ meal, name: MEAL_NAMES[meal] ?? "Snacks", foods: counts.find(c => c.meal === meal)?.n ?? 0 })).filter(x => x.foods > 0);
  return meals.length ? { meals } : null;
}

// The answer to "was it deleted?": yes applies what Lose It! shows now (the meals go); no keeps them and starts the checks again.
export async function resolveMissingMeals(date: string, deleted: boolean): Promise<DiaryDay> {
  if (deleted) {
    const state = loadState();
    delete state.missingMeals[date];
    saveState(state);
    await refreshDay(date, true); // expectFewer: believed straight away
  } else {
    const state = loadState();
    const m = state.missingMeals[date];
    if (m) { m.checks = 0; m.alerted = false; m.lastAt = new Date().toISOString(); }
    saveState(state);
  }
  return getDiaryDay(date);
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
    // The goal set in Lose It! (kept for an hour, so this is a request only about hourly).
    await getLoseItGoals().catch(() => null);
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

// ── The goal set in Lose It! ───────────────────────────────────────────────
// Read on request (~1 KB) and kept for an hour: it only changes when the goal is
// edited in Lose It! or a new weigh-in moves its projected date.
const GOALS_KEY = "loseit_goals";
const GOALS_MAX_AGE_MS = 60 * 60_000;

// The last goals read, without a network call (null before the first read).
export function cachedLoseItGoals(): LoseItGoals | null {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(GOALS_KEY) as { value_json: string } | undefined;
    return row ? (JSON.parse(row.value_json) as { goals: LoseItGoals }).goals : null;
  } catch { return null; }
}

export async function getLoseItGoals(force = false): Promise<{ goals: LoseItGoals; fetchedAt: string }> {
  const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(GOALS_KEY) as { value_json: string } | undefined;
  const cached = row ? (JSON.parse(row.value_json) as { goals: LoseItGoals; fetchedAt: string }) : null;
  if (cached && !force && Date.now() - Date.parse(cached.fetchedAt) < GOALS_MAX_AGE_MS) return cached;
  const today = localIsoDate();
  const goals = await withLoseItSession(who => fetchGoals(who, today));
  const fresh = { goals, fetchedAt: new Date().toISOString() };
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(GOALS_KEY, JSON.stringify(fresh));
  return fresh;
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
  mine: boolean;       // in the account's My Foods (or its recipes)
  recipe: boolean;     // one of the account's recipes
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
  const ins = db.prepare("INSERT OR REPLACE INTO loseit_my_foods (pk, name, brand, icon, locale, recipe) VALUES (?, ?, ?, ?, ?, ?)");
  db.transaction(() => {
    db.prepare("DELETE FROM loseit_my_foods").run();
    for (const f of foods) ins.run(toHex(f.pk), f.name, f.brand, f.icon, f.locale, f.recipe ? 1 : 0);
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
  const rows = getDb().prepare("SELECT pk, name, brand, icon, locale, recipe FROM loseit_my_foods ORDER BY rowid").all() as
    { pk: string; name: string; brand: string | null; icon: string | null; locale: string | null; recipe: number }[];
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
    .map(({ recipe, ...r }) => ({ ...r, mine: true, recipe: recipe === 1, timesLogged: counts.get(r.name.trim().toLowerCase()) ?? 0 }))
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
    .map(f => ({ pk: toHex(f.pk), name: f.name, brand: f.brand, icon: f.icon, locale: f.locale, mine: false, recipe: false, timesLogged: 0 }))
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
async function refreshDay(date: string, expectFewer = false): Promise<void> {
  const state = loadState();
  await syncDay(date, state, expectFewer);
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
export async function removeLoseItFood(date: string, item: CopyItem): Promise<DiaryDay> {
  await withLoseItSession(async who => {
    const entries = await fetchDayAndStore(who, date);
    const entry = findEntry(entries, item, new Set());
    if (!entry) throw new Error(`${item.name} is no longer in that day's Lose It! diary`);
    await deleteEntry(who, entry.node);
  });
  await refreshDay(date, true); // one food fewer is expected
  return getDiaryDay(date);
}

// The entry a diary row refers to: by its entry id, or — for rows from the
// export, or stored before entry ids were read correctly — by meal, name and
// calories. `used` stops two picks landing on the same entry.
function findEntry(entries: LoseItEntry[], it: CopyItem, used: Set<LoseItEntry>): LoseItEntry | undefined {
  const free = entries.filter(e => !used.has(e));
  return (it.entryId ? free.find(e => e.entryId === it.entryId) : undefined)
    ?? free.find(e => e.meal === it.meal && e.name === it.name.trim()
      && Math.abs((e.nutrients[NUTRIENT.kcal] ?? 0) - (it.kcal ?? 0)) <= 1);
}

// Reads a day from Lose It! and stores it too, so the rows shown (and their
// entry ids) match what was just read.
async function fetchDayAndStore(who: Parameters<typeof fetchDay>[0], date: string): Promise<LoseItEntry[]> {
  const entries = await fetchDay(who, date);
  const state = loadState();
  replaceDay(date, entries.map(e => rowFromEntry(e, state)), "rpc");
  saveState(state);
  return entries;
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
    const entries = await fetchDayAndStore(who, fromDate);
    const picks: { entry: LoseItEntry; meal: number }[] = [];
    if ("meal" in what) {
      for (const entry of entries) if (entry.meal === what.meal) picks.push({ entry, meal: what.meal });
    } else {
      const used = new Set<LoseItEntry>();
      for (const it of what.items) {
        const entry = findEntry(entries, it, used);
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

// ── Food diary as text, for the AI coach and the AI nutrition summary ──────

function amountText(r: { quantity: number | null; units: string | null }): string {
  if (r.quantity == null) return "";
  const q = Math.round(r.quantity * 100) / 100;
  return r.units ? `${q} ${r.units}${q !== 1 && r.units !== "Each" ? "s" : ""}` : String(q);
}

// One line per meal: "2026-10-28 Lunch (453 kcal): Dry Cured Ham, Marks And Spencer, 40 Grams, 52 kcal [P10 C0 F1]; …".
// detailed adds each food's macros; otherwise just name, amount and kcal.
export function foodDiaryLines(from: string, to: string, detailed: boolean): string[] {
  const rows = getDb().prepare("SELECT * FROM loseit_food_log WHERE date >= ? AND date <= ? ORDER BY date, meal, seq").all(from, to) as DbRow[];
  const out: string[] = [];
  const groups = new Map<string, DbRow[]>();
  for (const r of rows) {
    const k = `${r.date}|${r.meal}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  groups.forEach((list, k) => {
    const [date, meal] = k.split("|");
    const total = Math.round(list.reduce((a, r) => a + (r.kcal ?? 0), 0));
    const foods = list.map(r => {
      const bits = [r.name, r.brand, amountText(r), r.kcal != null ? `${Math.round(r.kcal)} kcal` : null].filter(Boolean).join(", ");
      const macros = detailed && (r.protein_g != null || r.carbs_g != null || r.fat_g != null)
        ? ` [P${Math.round(r.protein_g ?? 0)} C${Math.round(r.carbs_g ?? 0)} F${Math.round(r.fat_g ?? 0)}]` : "";
      return bits + macros;
    });
    out.push(`${date} ${MEAL_NAMES[Number(meal)] ?? "Snacks"} (${total} kcal): ${foods.join("; ")}`);
  });
  return out;
}

// Biggest calorie sources over a period: "Coffee (125ml / 12g): 14× , 1,567 kcal total (112 each)".
export function topFoodLines(from: string, to: string, n = 10): string[] {
  const rows = getDb().prepare(`
    SELECT name, COUNT(*) AS times, SUM(kcal) AS total FROM loseit_food_log
    WHERE date >= ? AND date <= ? AND kcal IS NOT NULL GROUP BY LOWER(TRIM(name)) ORDER BY total DESC LIMIT ?
  `).all(from, to, n) as { name: string; times: number; total: number }[];
  return rows.map(r => `${r.name}: ${r.times}×, ${Math.round(r.total).toLocaleString("en-GB")} kcal total (${Math.round(r.total / r.times)} each on average)`);
}


// ── Edit the amount of a logged food ───────────────────────────────────────

// Changes how much of a food was eaten; the calories and nutrients are scaled
// to match. quantity is in the entry's own unit, or in grams with unit "gram".
export async function editLoseItFood(date: string, item: CopyItem, quantity: number, unit: "food" | "gram" = "food"): Promise<DiaryDay> {
  if (!(quantity > 0 && quantity < 100_000)) throw new Error("quantity must be positive");
  await withLoseItSession(async who => {
    const entry = findEntry(await fetchDayAndStore(who, date), item, new Set());
    if (!entry) throw new Error(`${item.name} is no longer in that day's Lose It! diary`);
    await saveEntry(who, rescaleEntry(await currentBuild(who.cookie), entry.node, quantity, unit));
  });
  await refreshDay(date);
  return getDiaryDay(date);
}

// ── Move / copy between meals of the same day (drag and drop) ──────────────

// mode "move": the food changes meal (same entry). "copy": a second entry of
// the same food, amount and nutrients goes into the other meal.
export async function placeLoseItFood(date: string, item: CopyItem, toMeal: number, mode: "move" | "copy"): Promise<DiaryDay> {
  if (!(toMeal >= 0 && toMeal <= 3)) throw new Error("meal must be 0-3");
  await withLoseItSession(async who => {
    const entry = findEntry(await fetchDayAndStore(who, date), item, new Set());
    if (!entry) throw new Error(`${item.name} is no longer in that day's Lose It! diary`);
    const build = await currentBuild(who.cookie);
    await saveEntry(who, mode === "move" ? moveEntry(build, entry.node, toMeal) : copyEntry(build, entry.node, date, toMeal));
  });
  await refreshDay(date);
  return getDiaryDay(date);
}
