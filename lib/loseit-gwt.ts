import { randomBytes } from "crypto";
import { getDb } from "@/lib/db";

// Minimal client for Lose It!'s web-app RPC (GWT-RPC, reverse-engineered —
// see github.com/RichClarkeAI/loseit-cli and github.com/atfinke/loseit-mcp).
// Used for the cheap per-day diary read (~4.6 KB gzipped) instead of the
// 1.6 MB full CSV export, which is only fetched once for the history import,
// and for food search / adding / removing diary entries (web Nutrition page).
//
// GWT-RPC is positional: a request is "7|0|<n>|<string table>|<tokens>|" and
// a response is //OK[<tokens>..., [<string table>], flags, version], with the
// tokens read back-to-front. Nothing is self-describing, so every class read
// below has its field order hardcoded — worked out from live responses and
// checked against ~40 days of the CSV export (2021 → 2026). Anything that
// doesn't match the expected shape throws, so a Lose It! redeploy that
// changes a class fails loudly instead of storing garbage.

const SERVICE_URL = "https://www.loseit.com/web/service";
const SERVICE = "com.loseit.core.client.service.LoseItRemoteService";
const BUILD_KEY = "loseit_build";
const BUILD_REFRESH_MIN_MS = 60 * 60_000; // never re-discover more than hourly

// Serialized type names (with the hash suffix GWT checks) that requests need.
// Re-read from the serialization policy file whenever the build is refreshed.
const REQUEST_TYPES = [
  "com.loseit.core.client.service.ServiceRequestToken",
  "com.loseit.core.client.model.UserId",
  "com.loseit.core.shared.model.DayDate",
  "java.util.Date",
] as const;

export interface LoseItBuild {
  moduleBase: string;   // e.g. https://d3hsih69yn4d89.cloudfront.net/web/
  permutation: string;  // x-gwt-permutation header
  policy: string;       // serialization policy hash (request string #2)
  types: Record<string, string>; // class name → "class/hash"
  discoveredAt: string;
}

export interface GwtIdentity {
  cookie: string;
  userId: number;
  username: string;
}

export class LoseItAuthError extends Error {}
export class LoseItBuildError extends Error {}

// ── Build discovery ────────────────────────────────────────────────────────
// The policy hash and permutation change whenever Lose It! redeploys its web
// client. Found from public static files (no account involved): the home
// page names web.nocache.js, which lists the permutations; the permutation's
// <hash>.cache.js holds the policy hash in the RPC proxy's constructor
// (`…,null,'<32 hex>',…` — the only such literal); the <policy>.gwt.rpc file
// lists every serializable type with its hash. ~950 KB, so it's cached in
// kv_config and only redone when an RPC call reports a build mismatch.

function loadBuild(): LoseItBuild | null {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(BUILD_KEY) as { value_json: string } | undefined;
    if (row) return JSON.parse(row.value_json) as LoseItBuild;
  } catch {}
  return null;
}

function saveBuild(b: LoseItBuild): void {
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(BUILD_KEY, JSON.stringify(b));
}

// Where the app's bootstrap script lived when this was written; only used if
// the logged-in home page doesn't name it.
const FALLBACK_NOCACHE = "https://d3hsih69yn4d89.cloudfront.net/web/web.nocache.js";

async function fetchText(url: string, cookie?: string): Promise<string> {
  const res = await fetch(url, { headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new LoseItBuildError(`${url} returned ${res.status}`);
  return res.text();
}

// Logged out, loseit.com is the marketing site; the web app (and so the
// bootstrap script tag) is only served with a session cookie.
export async function discoverBuild(cookie: string): Promise<LoseItBuild> {
  const home = await fetchText("https://www.loseit.com/", cookie).catch(() => "");
  const nocacheUrl = home.match(/src="(https:\/\/[^"]+\/web\.nocache\.js[^"]*)"/)?.[1] ?? FALLBACK_NOCACHE;
  const moduleBase = nocacheUrl.replace(/web\.nocache\.js.*$/, "");

  // First permutation listed is the default "en" locale build.
  const nocache = await fetchText(nocacheUrl);
  const permutation = nocache.match(/'([0-9A-F]{32})'/)?.[1];
  if (!permutation) throw new LoseItBuildError("no permutation in web.nocache.js");

  const cacheJs = await fetchText(`${moduleBase}${permutation}.cache.js`);
  const policies = Array.from(cacheJs.matchAll(/,null,'([0-9A-F]{32})'/g), m => m[1]);
  if (policies.length !== 1) throw new LoseItBuildError(`expected 1 policy hash, found ${policies.length}`);
  const policy = policies[0];

  const policyFile = await fetchText(`${moduleBase}${policy}.gwt.rpc`);
  const types: Record<string, string> = {};
  for (const line of policyFile.split(/\r?\n/)) {
    const parts = line.split(", ");
    if (parts.length >= 6 && /\/\d+$/.test(parts[5])) types[parts[0]] = parts[5];
  }
  for (const t of REQUEST_TYPES) {
    if (!types[t]) throw new LoseItBuildError(`policy file has no ${t}`);
  }

  const build: LoseItBuild = { moduleBase, permutation, policy, types, discoveredAt: new Date().toISOString() };
  saveBuild(build);
  return build;
}

async function getBuild(cookie: string): Promise<LoseItBuild> {
  return loadBuild() ?? discoverBuild(cookie);
}

// ── Requests ──────────────────────────────────────────────────────────────

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789$_";

// GWT longs travel as base-64 strings. Read longs are kept as those strings
// (some are negative, e.g. "P__________" = -1); the only ones written fresh
// are timestamps, which fit easily in a double.
function encodeLong(n: number): string {
  let v = Math.floor(n), s = "";
  while (v > 0) { s = B64[v % 64] + s; v = Math.floor(v / 64); }
  return s || "A";
}

// Lose It! day numbers count from 2000-12-31 (day 0).
export function loseItDayNumber(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(2000, 11, 31)) / 86_400_000);
}

function hoursFromGmt(): number {
  return -new Date().getTimezoneOffset() / 60;
}

type ParamWriter = (idx: (s: string) => number, type: (name: string) => string) => (string | number)[];

// Every LoseItRemoteService method takes a ServiceRequestToken first; it
// counts as a parameter. Token on the wire: type, 0, UserId{type, id},
// username, hours-from-GMT.
function buildRequest(build: LoseItBuild, who: GwtIdentity, method: string, paramTypes: string[], writeParams: ParamWriter): string {
  // Primitives ("I", "Z") and interfaces (IPrimaryKey) aren't in the policy
  // file and are sent by bare name, as the web app does.
  const type = (name: string) => {
    const sig = build.types[name];
    if (sig) return sig;
    if (/^[A-Z]$/.test(name) || /\.interfaces\.I[A-Z]\w*$/.test(name)) return name;
    throw new LoseItBuildError(`unknown type ${name}`);
  };
  const allTypes = [type("com.loseit.core.client.service.ServiceRequestToken"), ...paramTypes.map(type)];
  const strings: string[] = [build.moduleBase, build.policy, SERVICE, method, ...allTypes];
  const idx = (s: string) => {
    let i = strings.indexOf(s);
    if (i < 0) { strings.push(s); i = strings.length - 1; }
    return i + 1;
  };
  const tokens: (string | number)[] = [1, 2, 3, 4, allTypes.length, ...allTypes.map(idx)];
  tokens.push(idx(allTypes[0]), 0, idx(type("com.loseit.core.client.model.UserId")), who.userId, idx(who.username), hoursFromGmt());
  tokens.push(...writeParams(idx, type));
  return `7|0|${strings.length}|${strings.join("|")}|${tokens.join("|")}|`;
}

export interface GwtResponse { tokens: unknown[]; strings: string[] }

function parseResponse(text: string): GwtResponse {
  // GWT splits very large arrays as "[…].concat([…])" — rejoin them before
  // JSON.parse. A diary day is far below that size, so this rarely applies.
  let body = text.slice(4);
  if (body.includes("].concat([")) body = body.replace(/\]\.concat\(\[/g, ",").replace(/\]\)+$/, "]");
  const arr = JSON.parse(body) as unknown[];
  const strings = arr[arr.length - 3];
  if (!Array.isArray(strings)) throw new Error("malformed GWT response (no string table)");
  return { tokens: arr.slice(0, arr.length - 3), strings: strings as string[] };
}

// One RPC round trip. Throws LoseItAuthError when the session is no longer
// accepted and LoseItBuildError when the build values look stale, so the
// caller can re-login / re-discover and retry once.
async function rpc(who: GwtIdentity, method: string, paramTypes: string[], writeParams: ParamWriter): Promise<GwtResponse> {
  const build = await getBuild(who.cookie);
  const res = await fetch(SERVICE_URL, {
    method: "POST",
    headers: {
      "content-type": "text/x-gwt-rpc; charset=utf-8",
      "x-gwt-module-base": build.moduleBase,
      "x-gwt-permutation": build.permutation,
      "x-loseit-gwtversion": "devmode",
      "x-loseit-hoursfromgmt": String(hoursFromGmt()),
      origin: "https://www.loseit.com",
      referer: "https://www.loseit.com/",
      cookie: who.cookie,
    },
    body: buildRequest(build, who, method, paramTypes, writeParams),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (res.status === 401 || res.status === 403) throw new LoseItAuthError(`${method}: HTTP ${res.status}`);
  if (text.startsWith("//OK")) return parseResponse(text);
  if (text.startsWith("//EX")) {
    if (/IncompatibleRemoteService|SerializationException|SerializationPolicy/.test(text)) {
      throw new LoseItBuildError(`${method}: ${text.slice(0, 200)}`);
    }
    if (/Auth|NotLoggedIn|Session|Login/i.test(text)) throw new LoseItAuthError(`${method}: ${text.slice(0, 200)}`);
  }
  throw new Error(`${method}: HTTP ${res.status} ${text.slice(0, 200)}`);
}

// Retries once after re-discovering the build, but only if the cached build
// is more than an hour old (a fresh build failing means something else is wrong).
async function rpcWithBuildRetry(who: GwtIdentity, method: string, paramTypes: string[], writeParams: ParamWriter): Promise<GwtResponse> {
  try {
    return await rpc(who, method, paramTypes, writeParams);
  } catch (e) {
    const build = loadBuild();
    // No cached build means rpc() just discovered one (or failed to) — don't repeat it.
    const stale = !!build && Date.now() - Date.parse(build.discoveredAt) > BUILD_REFRESH_MIN_MS;
    if (!(e instanceof LoseItBuildError) || !stale) throw e;
    await discoverBuild(who.cookie);
    return rpc(who, method, paramTypes, writeParams);
  }
}

// Cheap call (~1 KB gzipped) used to check a session still works.
export async function pingLoseIt(who: GwtIdentity): Promise<void> {
  await rpcWithBuildRetry(who, "getGoalsData", [], () => []);
}

// ── Object codec ───────────────────────────────────────────────────────────
// GWT streams carry no field names, so each class the food log uses has its
// field layout listed here: n = number, s = string, l = long, o:<Class> =
// nested object (the class is checked, and used to resolve back-references).
// Worked out from live responses; checked against ~40 days of the CSV export
// and by writing entries back. Reading builds a tree that can be edited and
// written straight back in the same order — that's how foods get logged.

type Kind = "n" | "s" | "l" | `o:${string}`;

const SCHEMA: Record<string, Kind[]> = {
  FoodLogEntry: ["o:FoodIdentifier", "n", "o:Verification", "l", "o:SimplePrimaryKey", "o:FoodLogEntryContext",
    "o:FoodLogEntryType", "o:FoodLogEntryTypeExtra", "o:FoodServing"],
  FoodIdentifier: ["n", "s", "s", "s", "s", "o:FoodProductType"], // ?, icon, locale, name, brand, product type
  SimplePrimaryKey: ["o:[B"],
  FoodLogEntryContext: ["o:Timestamp", "o:DayDate", "n", "n", "n", "n", "n", "n"],
  Timestamp: ["l", "n"],
  DayDate: ["o:Date", "n", "n"], // date, day number, hours from GMT
  Date: ["l"],
  // nutrients, size, [servings, quantity, quantity, 0], 2 longs, entry primary key
  FoodServing: ["o:FoodNutrients", "o:FoodServingSize", "n", "n", "n", "n", "l", "l", "o:SimplePrimaryKey"],
  FoodNutrients: ["n", "n", "o:HashMap"], // [servings the values are for, servings], nutrient map
  FoodServingSize: ["n", "n", "o:FoodMeasure"], // servings, ?, unit
  FoodMeasure: ["n"],
  Double: ["n"],
  Integer: ["n"],
  // Enums: just an ordinal.
  FoodProductType: ["n"], FoodLogEntryType: ["n"], FoodLogEntryTypeExtra: ["n"], FoodMeasurement: ["n"], Verification: ["n"],
};

export type GField = number | string | null | GNode; // strings and longs are both kept as strings

export interface GNode {
  sig: string;        // serialized type name with hash, e.g. "…FoodLogEntry/264522954"
  type: string;       // short class name
  f: GField[];        // fields in SCHEMA order
  bytes?: number[];   // [B
  map?: [GNode | null, GNode | null][]; // HashMap
}

const shortType = (t: string) => t.replace(/\/\d+$/, "").split(".").pop() ?? t;

class Reader {
  p = 0;
  private seen: GNode[] = [];
  private off: number | null = null;
  constructor(private t: unknown[], private s: string[]) {}

  private next(): unknown {
    if (this.p >= this.t.length) throw new Error("GWT stream underrun");
    return this.t[this.p++];
  }
  num(): number {
    const v = this.next();
    if (typeof v !== "number") throw new Error(`expected number at ${this.p - 1}, got ${JSON.stringify(v)}`);
    return v;
  }
  str(): string | null {
    const i = this.num();
    return i === 0 ? null : this.s[i - 1] ?? null;
  }
  long(): string {
    const v = this.next();
    if (typeof v === "string") return v;
    if (typeof v === "number") return encodeLong(v);
    throw new Error(`expected long at ${this.p - 1}`);
  }

  // 0 = null, <0 = back-reference to an already-read object, >0 = a new
  // instance of string-table type N (registered before its fields are read).
  node(expect: string): GNode | null {
    const at = this.p;
    const t = this.num();
    if (t === 0) return null;
    if (t < 0) return this.resolve(-t, expect);
    const sig = this.s[t - 1] ?? "";
    const type = shortType(sig);
    if (type !== expect) throw new Error(`at ${at}: expected ${expect}, got ${type}`);
    const n: GNode = { sig, type, f: [] };
    this.seen.push(n);
    if (type === "[B") {
      const len = this.num();
      n.bytes = [];
      for (let i = 0; i < len; i++) n.bytes.push(this.num());
    } else if (type === "HashMap") {
      const size = this.num();
      n.map = [];
      for (let i = 0; i < size; i++) n.map.push([this.node("FoodMeasurement"), this.node("Double")]);
    } else {
      const kinds = SCHEMA[type];
      if (!kinds) throw new Error(`no layout for ${type}`);
      for (const k of kinds) {
        n.f.push(k === "n" ? this.num() : k === "s" ? this.str() : k === "l" ? this.long() : this.node(k.slice(2)));
      }
    }
    return n;
  }

  // Back-references count every object in the whole response, but reading
  // starts at the food log, so the absolute→local offset is calibrated on the
  // first one (in practice always a shared enum constant seen just before).
  private resolve(k: number, expect: string): GNode {
    if (this.off === null) {
      const i = this.seen.findIndex(o => o.type === expect);
      if (i < 0) throw new Error(`cannot calibrate back-reference ${k} (${expect})`);
      this.off = k - 1 - i;
    }
    const o = this.seen[k - 1 - this.off];
    if (!o) throw new Error(`back-reference ${k} outside decoded region`);
    if (o.type !== expect) throw new Error(`back-reference ${k} is ${o.type}, expected ${expect}`);
    return o;
  }
}

// Writes a tree back as request tokens. Every object is written out in full
// (no back-references) — the server accepts that, and it keeps this simple.
function writeNode(n: GNode | null, idx: (s: string) => number, out: (string | number)[]): void {
  if (!n) { out.push(0); return; }
  out.push(idx(n.sig));
  if (n.bytes) { out.push(n.bytes.length, ...n.bytes); return; }
  if (n.map) {
    out.push(n.map.length);
    for (const [k, v] of n.map) { writeNode(k, idx, out); writeNode(v, idx, out); }
    return;
  }
  const kinds = SCHEMA[n.type];
  n.f.forEach((v, i) => {
    const k = kinds[i];
    if (k === "n") out.push(v as number);
    else if (k === "s") out.push(v === null ? 0 : idx(v as string));
    else if (k === "l") out.push(v as string);
    else writeNode(v as GNode | null, idx, out);
  });
}

const fNum = (n: GNode | null | undefined, i: number): number => (n?.f[i] as number) ?? 0;
const fNode = (n: GNode | null | undefined, i: number): GNode | null => (n?.f[i] as GNode | null) ?? null;
const fStr = (n: GNode | null | undefined, i: number): string | null => {
  const v = n?.f[i];
  return typeof v === "string" ? v : null;
};
const hex = (bytes: number[] | undefined) => (bytes ?? []).map(b => (b & 0xff).toString(16).padStart(2, "0")).join("");
const measureOf = (serving: GNode | null): number | null => {
  const m = fNode(fNode(serving, 1), 2);
  return m ? fNum(m, 0) : null;
};

// ── Food log entries ───────────────────────────────────────────────────────

export interface LoseItEntry {
  entryId: string;          // hex of the entry's own 16-byte primary key
  meal: number;             // 0 Breakfast, 1 Lunch, 2 Dinner, 3 Snacks
  name: string;
  brand: string | null;
  icon: string | null;
  quantity: number | null;  // in the food's unit
  measureId: number | null; // the unit; see MEASURE_UNITS in lib/loseit-food.ts
  nutrients: Record<number, number>; // FoodMeasurement ordinal → value for the logged amount
  node: GNode;              // the raw entry, for writing it back (e.g. to delete it)
}

function entryOf(node: GNode): LoseItEntry {
  const ident = fNode(node, 0);
  const serving = fNode(node, 8);
  const nutrients: Record<number, number> = {};
  for (const [k, v] of fNode(fNode(serving, 0), 2)?.map ?? []) {
    if (k && v) nutrients[fNum(k, 0)] = fNum(v, 0);
  }
  const name = (fStr(ident, 3) ?? "").trim();
  if (!name) throw new Error("food entry without a name");
  const brand = fStr(ident, 4)?.trim();
  const meal = fNode(node, 6);
  return {
    entryId: hex(fNode(fNode(serving, 8), 0)?.bytes),
    meal: meal ? fNum(meal, 0) : 3,
    name,
    brand: brand || null,
    icon: fStr(ident, 1),
    quantity: serving ? fNum(serving, 3) : null,
    measureId: measureOf(serving),
    nutrients,
    node,
  };
}

function typeIndex(strings: string[], prefix: string): number {
  return strings.findIndex(s => s.startsWith(prefix)) + 1;
}

export function decodeFoodLog(res: GwtResponse): LoseItEntry[] {
  const rev = [...res.tokens].reverse();
  const arrIdx = typeIndex(res.strings, "[Lcom.loseit.core.client.model.FoodLogEntry;");
  const entryIdx = typeIndex(res.strings, "com.loseit.core.client.model.FoodLogEntry/");
  // No FoodLogEntry type anywhere in the response ⇒ nothing logged that day.
  if (!arrIdx || !entryIdx) return [];
  const anchor = rev.findIndex((v, i) => v === arrIdx && rev[i + 2] === entryIdx);
  if (anchor < 0) throw new Error("food log array not found in response");
  const r = new Reader(rev.slice(anchor + 1), res.strings);
  const n = r.num();
  if (n < 0 || n > 500) throw new Error(`implausible food log length ${n}`);
  const entries: LoseItEntry[] = [];
  for (let i = 0; i < n; i++) {
    const node = r.node("FoodLogEntry");
    if (!node) throw new Error("null food log entry");
    entries.push(entryOf(node));
  }
  return entries;
}

// The whole diary for one local day. DayDate on the wire: Date{ms}, day
// number, hours from GMT — the timestamp is the day's 01:00:01 UTC.
export async function fetchDay(who: GwtIdentity, isoDate: string): Promise<LoseItEntry[]> {
  const [y, m, d] = isoDate.split("-").map(Number);
  const res = await rpcWithBuildRetry(who, "getDailyDetailsForDate", ["com.loseit.core.shared.model.DayDate"], (idx, type) => [
    idx(type("com.loseit.core.shared.model.DayDate")),
    idx(type("java.util.Date")),
    encodeLong(Date.UTC(y, m - 1, d, 1, 0, 1)),
    loseItDayNumber(isoDate),
    0,
  ]);
  return decodeFoodLog(res);
}

// ── Search and logging ─────────────────────────────────────────────────────

export interface LoseItSearchFood {
  pk: number[];          // the food's 16-byte primary key
  name: string;
  brand: string | null;
  icon: string | null;
  locale: string | null;
}

export async function searchFoods(who: GwtIdentity, query: string, max = 25): Promise<LoseItSearchFood[]> {
  const res = await rpcWithBuildRetry(who, "searchFoods", ["java.lang.String", "java.lang.String", "I", "Z", "Z"],
    idx => [idx(query), idx("en-GB"), max, 1, 1]);
  return parseSearchFoods(res);
}

// The account's own foods: "My Foods" (every food it has logged plus its
// custom foods, ~1,000, ~45 KB gzipped) and its recipes, which Lose It!
// keeps in a separate, much smaller list. Both log the same way.
export async function fetchMyFoods(who: GwtIdentity): Promise<LoseItSearchFood[]> {
  const foods = parseSearchFoods(await rpcWithBuildRetry(who, "getMyFoodsSearchResults", [], () => []));
  const recipes = parseSearchFoods(await rpcWithBuildRetry(who, "getRecipesSearchResults", [], () => []));
  return [...foods, ...recipes];
}

// Search results are a list mixing headers, previous meals and foods; only
// foods are picked out, each anchored on SearchResultFood → SimplePrimaryKey
// → [B → 16 and followed by icon, locale, name, brand.
function parseSearchFoods(res: GwtResponse): LoseItSearchFood[] {
  const rev = [...res.tokens].reverse();
  const tFood = typeIndex(res.strings, "com.loseit.core.client.model.search.SearchResultFood/");
  const tPk = typeIndex(res.strings, "com.loseit.core.client.model.SimplePrimaryKey/");
  const tBytes = typeIndex(res.strings, "[B/");
  if (!tFood || !tPk || !tBytes) return [];
  const str = (v: unknown) => (typeof v === "number" && v > 0 ? res.strings[v - 1] ?? null : null);
  const out: LoseItSearchFood[] = [];
  for (let i = 0; i + 24 <= rev.length; i++) {
    if (rev[i] !== tFood || rev[i + 1] !== tPk || rev[i + 2] !== tBytes || rev[i + 3] !== 16) continue;
    const pk = rev.slice(i + 4, i + 20);
    if (!pk.every(b => typeof b === "number" && b >= -128 && b <= 127)) continue;
    const name = str(rev[i + 22])?.trim();
    if (!name) continue;
    out.push({ pk: pk as number[], icon: str(rev[i + 20]), locale: str(rev[i + 21]), name, brand: str(rev[i + 23])?.trim() || null });
  }
  return out;
}

// A new, unsaved diary entry for a food, filled in by Lose It! with the
// food's default amount and its nutrients per base serving. Saving it
// (saveEntry) is what adds it to the diary. Lose It! picks its entry key
// here, so saving the same draft twice updates rather than duplicates.
export async function getFoodDraft(who: GwtIdentity, food: Pick<LoseItSearchFood, "pk" | "name" | "locale">): Promise<GNode> {
  const res = await rpcWithBuildRetry(who, "getUnsavedFoodLogEntry",
    ["com.loseit.core.client.model.interfaces.IPrimaryKey", "java.lang.String", "java.lang.String"],
    (idx, type) => [
      idx(type("com.loseit.core.client.model.SimplePrimaryKey")), idx(type("[B")), 16, ...food.pk,
      idx(food.locale ?? "en-GB"), idx(food.name),
    ]);
  return parseDraft(res);
}

export function parseDraft(res: GwtResponse): GNode {
  const rev = [...res.tokens].reverse();
  const entryIdx = typeIndex(res.strings, "com.loseit.core.client.model.FoodLogEntry/");
  const identIdx = typeIndex(res.strings, "com.loseit.core.client.model.FoodIdentifier/");
  const at = entryIdx && identIdx ? rev.findIndex((v, i) => v === entryIdx && rev[i + 1] === identIdx) : -1;
  if (at < 0) throw new Error("Lose It! returned no entry for that food");
  const node = new Reader(rev.slice(at), res.strings).node("FoodLogEntry");
  if (!node) throw new Error("Lose It! returned an empty entry");
  return node;
}

export interface DraftSummary {
  quantity: number;           // default amount, in the food's unit
  measureId: number | null;
  nutrients: Record<number, number>; // for the default amount
}

// Nutrient ordinal 2 isn't a nutrient: it's the weight in grams of the
// amount the map is for, which is what lets any food be logged in grams.
export const WEIGHT_G = 2;
const GRAM_MEASURE = 8;

// A draft's nutrients are for FoodNutrients[0] servings; its default amount
// is FoodServing[2] servings = FoodServing[3] units.
export function summarizeDraft(draft: GNode): DraftSummary {
  const serving = fNode(draft, 8);
  const fn = fNode(serving, 0);
  const per = fNum(fn, 0) || 1;
  const servings = fNum(serving, 2) || 1;
  const nutrients: Record<number, number> = {};
  for (const [k, v] of fNode(fn, 2)?.map ?? []) if (k && v) nutrients[fNum(k, 0)] = fNum(v, 0) * servings / per;
  return { quantity: fNum(serving, 3) || 1, measureId: measureOf(serving), nutrients };
}

function nodeFor(build: LoseItBuild, cls: string, f: GField[]): GNode {
  const sig = build.types[cls];
  if (!sig) throw new LoseItBuildError(`unknown type ${cls}`);
  return { sig, type: shortType(sig), f };
}

// Turns a draft into the entry to save: date, meal, and an amount — in the
// food's own unit (scaled from the draft's default amount) or, with
// unit "gram", in grams (scaled from the food's weight, and logged with Gram
// as its unit). A logged entry has FoodNutrients = [s, s], serving size s
// and tail [s, q, q, 0], with the nutrients already multiplied out for s servings.
export function prepareEntry(
  build: LoseItBuild, draft: GNode, isoDate: string, meal: number, quantity: number, unit: "food" | "gram" = "food",
): GNode {
  const e = JSON.parse(JSON.stringify(draft)) as GNode;
  const serving = fNode(e, 8);
  const fn = fNode(serving, 0);
  const size = fNode(serving, 1);
  const map = fNode(fn, 2);
  if (!serving || !fn || !size || !map?.map) throw new Error("unexpected draft entry shape");
  const per = fNum(fn, 0) || 1;
  let s: number;
  if (unit === "gram") {
    const weight = map.map.find(([k]) => k && fNum(k, 0) === WEIGHT_G)?.[1];
    const gramsPerServing = weight ? fNum(weight, 0) / per : 0;
    if (!(gramsPerServing > 0)) throw new Error("Lose It! has no weight for this food, so it can't be logged in grams");
    s = quantity / gramsPerServing;
    size.f[2] = nodeFor(build, "com.loseit.core.client.model.FoodMeasure", [GRAM_MEASURE]);
  } else {
    s = (fNum(serving, 2) || 1) * (quantity / (fNum(serving, 3) || 1));
  }
  for (const [, v] of map.map) if (v) v.f[0] = fNum(v, 0) * s / per;
  fn.f[0] = s; fn.f[1] = s;
  size.f[0] = s;
  serving.f[2] = s; serving.f[3] = quantity; serving.f[4] = quantity;

  setDayAndMeal(build, e, isoDate, meal);
  return e;
}

function setDayAndMeal(build: LoseItBuild, e: GNode, isoDate: string, meal: number): void {
  e.f[6] = nodeFor(build, "com.loseit.core.client.model.interfaces.FoodLogEntryType", [meal]);
  const ctx = fNode(e, 5);
  if (!ctx) throw new Error("entry has no context");
  const [y, m, d] = isoDate.split("-").map(Number);
  ctx.f[1] = nodeFor(build, "com.loseit.core.shared.model.DayDate", [
    nodeFor(build, "java.util.Date", [encodeLong(Date.UTC(y, m - 1, d, 1, 0, 1))]),
    loseItDayNumber(isoDate),
    hoursFromGmt(),
  ]);
}

// The same entry in another meal. Saved with its own key, Lose It! updates
// it in place (checked live: same id, new meal, no duplicate).
export function moveEntry(build: LoseItBuild, src: GNode, meal: number): GNode {
  const e = JSON.parse(JSON.stringify(src)) as GNode;
  e.f[6] = nodeFor(build, "com.loseit.core.client.model.interfaces.FoodLogEntryType", [meal]);
  return e;
}

// A copy of a logged entry (same food, amount and nutrients) as a new entry
// on another day/meal: a fresh random entry key (as the CLI does; Lose It!
// keys are just 16 random bytes), no logged-at time, and "now" as its
// last-changed times so Lose It!'s apps sync it.
export function copyEntry(build: LoseItBuild, src: GNode, isoDate: string, meal: number): GNode {
  const e = JSON.parse(JSON.stringify(src)) as GNode;
  const serving = fNode(e, 8);
  const keyBytes = fNode(fNode(serving, 8), 0);
  if (!serving || !keyBytes?.bytes) throw new Error("entry has no key");
  keyBytes.bytes = Array.from(randomBytes(16), b => (b > 127 ? b - 256 : b));
  const now = encodeLong(Date.now());
  e.f[3] = now;
  serving.f[7] = now;
  const ctx = fNode(e, 5);
  if (ctx) ctx.f[0] = null;
  setDayAndMeal(build, e, isoDate, meal);
  return e;
}

async function sendEntry(who: GwtIdentity, method: "updateFoodLogEntry" | "deleteFoodLogEntry", entry: GNode): Promise<void> {
  await rpcWithBuildRetry(who, method, ["com.loseit.core.client.model.FoodLogEntry"], idx => {
    const out: (string | number)[] = [];
    writeNode(entry, idx, out);
    return out;
  });
}

export async function saveEntry(who: GwtIdentity, entry: GNode): Promise<void> {
  await sendEntry(who, "updateFoodLogEntry", entry);
}

export async function deleteEntry(who: GwtIdentity, entry: GNode): Promise<void> {
  await sendEntry(who, "deleteFoodLogEntry", entry);
}

export async function currentBuild(cookie: string): Promise<LoseItBuild> {
  return getBuild(cookie);
}
