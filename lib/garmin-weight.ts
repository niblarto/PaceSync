import fs from "fs";
import os from "os";
import path from "path";
import { getDb } from "@/lib/db";

// Pulls weigh-ins straight from Garmin Connect (weight-service), using the
// same DI OAuth tokens GarminDB keeps for its daily sync (see
// app/api/garmin/courses/route.ts). Lets the Nutrition page refresh the
// current weight without waiting for GarminDB's 06:00 sync.

const TOKENS_FILE = path.join(os.homedir(), ".GarminDb", "garmin_tokens.json");

interface DiTokens { di_token: string; di_refresh_token: string; di_client_id: string }

function loadTokens(): DiTokens | null {
  try {
    const t = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf-8")) as DiTokens;
    if (t.di_token && t.di_refresh_token && t.di_client_id) return t;
  } catch {}
  return null;
}

// Rotated token pair is written back so GarminDB's next sync keeps working.
async function refreshDiToken(t: DiTokens): Promise<string | null> {
  const res = await fetch("https://diauth.garmin.com/di-oauth2-service/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.di_refresh_token, client_id: t.di_client_id }),
  });
  if (!res.ok) return null;
  const d = await res.json() as { access_token: string; refresh_token?: string };
  fs.writeFileSync(TOKENS_FILE, JSON.stringify({
    di_token: d.access_token,
    di_refresh_token: d.refresh_token ?? t.di_refresh_token,
    di_client_id: t.di_client_id,
  }), "utf-8");
  return d.access_token;
}

let ready = false;
function db() {
  const d = getDb();
  if (!ready) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS garmin_weights (
        date TEXT PRIMARY KEY,
        weight_kg REAL NOT NULL,
        body_fat REAL,
        measured_at TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );
    `);
    ready = true;
  }
  return d;
}

// When weigh-ins were last fetched from Garmin Connect (ISO), if ever.
export function lastGarminWeightFetch(): string | null {
  const row = db().prepare("SELECT MAX(fetched_at) AS at FROM garmin_weights").get() as { at: string | null };
  return row?.at ?? null;
}

export function getGarminApiWeights(since: string): { date: string; kg: number; measuredAt: string }[] {
  return db().prepare(
    "SELECT date, weight_kg AS kg, measured_at AS measuredAt FROM garmin_weights WHERE date >= ? ORDER BY date",
  ).all(since) as { date: string; kg: number; measuredAt: string }[];
}

interface WeightSample {
  calendarDate: string;
  weight: number | null; // grams
  bodyFat: number | null;
  timestampGMT: number | null;
  date: number | null;
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export type WeightRefreshResult =
  | { ok: true; days: number; latest: { date: string; kg: number } | null }
  | { ok: false; error: string };

// Fetches the last `days` days of weigh-ins and stores the latest one per day.
export async function refreshGarminWeights(days = 30): Promise<WeightRefreshResult> {
  const tokens = loadTokens();
  if (!tokens) return { ok: false, error: "Garmin sign-in not found (is GarminDB set up?)" };
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  const url = `https://connectapi.garmin.com/weight-service/weight/dateRange?startDate=${ymd(start)}&endDate=${ymd(end)}`;
  const get = (token: string) => fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(20_000) });

  let res: Response;
  try {
    res = await get(tokens.di_token);
    if (res.status === 401 || res.status === 403) {
      const fresh = await refreshDiToken(tokens);
      if (!fresh) return { ok: false, error: "Garmin sign-in expired and couldn't be renewed" };
      res = await get(fresh);
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Garmin request failed" };
  }
  if (!res.ok) return { ok: false, error: `Garmin weight request failed (${res.status})` };

  const data = await res.json() as { dateWeightList?: WeightSample[] };
  // Latest weigh-in per calendar day.
  const byDay = new Map<string, WeightSample>();
  for (const s of data.dateWeightList ?? []) {
    if (!s.calendarDate || !s.weight) continue;
    const prev = byDay.get(s.calendarDate);
    if (!prev || (s.timestampGMT ?? 0) > (prev.timestampGMT ?? 0)) byDay.set(s.calendarDate, s);
  }

  const now = new Date().toISOString();
  const upsert = db().prepare(`
    INSERT INTO garmin_weights (date, weight_kg, body_fat, measured_at, fetched_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET weight_kg = excluded.weight_kg, body_fat = excluded.body_fat,
      measured_at = excluded.measured_at, fetched_at = excluded.fetched_at
  `);
  let latest: { date: string; kg: number } | null = null;
  db().transaction(() => {
    byDay.forEach((s, date) => {
      const kg = s.weight! / 1000; // exact (Garmin records grams)
      upsert.run(date, kg, s.bodyFat ?? null, new Date(s.timestampGMT ?? s.date ?? Date.now()).toISOString(), now);
      if (!latest || date > latest.date) latest = { date, kg };
    });
  })();
  return { ok: true, days: byDay.size, latest };
}
