import fs from "fs";
import os from "os";
import path from "path";
import { getDb } from "@/lib/db";

// Direct Garmin Connect API calls (connectapi.garmin.com) using the DI OAuth
// tokens GarminDB keeps for its daily sync. Used for data GarminDB doesn't
// have yet: today's figures only land there once the day is over.

const TOKENS_FILE = path.join(os.homedir(), ".GarminDb", "garmin_tokens.json");

interface DiTokens { di_token: string; di_refresh_token: string; di_client_id: string }

function loadTokens(): DiTokens | null {
  try {
    const t = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf-8")) as DiTokens;
    if (t.di_token && t.di_refresh_token && t.di_client_id) return t;
  } catch {}
  return null;
}

// The rotated token pair is written back so GarminDB's next sync keeps working.
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

export async function garminConnectGet<T>(apiPath: string): Promise<T> {
  const tokens = loadTokens();
  if (!tokens) throw new Error("Garmin sign-in not found (is GarminDB set up?)");
  const get = (token: string) => fetch(`https://connectapi.garmin.com${apiPath}`, {
    headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(20_000),
  });
  let res = await get(tokens.di_token);
  if (res.status === 401 || res.status === 403) {
    const fresh = await refreshDiToken(tokens);
    if (!fresh) throw new Error("Garmin sign-in expired and couldn't be renewed");
    res = await get(fresh);
  }
  if (!res.ok) throw new Error(`Garmin request failed (${res.status})`);
  return res.json() as Promise<T>;
}

function kvGet<T>(key: string): T | null {
  const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(key) as { value_json: string } | undefined;
  if (!row) return null;
  try { return JSON.parse(row.value_json) as T; } catch { return null; }
}

function kvSet(key: string, value: unknown): void {
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(key, JSON.stringify(value));
}

async function displayName(): Promise<string> {
  const cached = kvGet<string>("garmin_display_name");
  if (cached) return cached;
  const p = await garminConnectGet<{ displayName: string }>("/userprofile-service/socialProfile");
  kvSet("garmin_display_name", p.displayName);
  return p.displayName;
}

export interface DayRecovery {
  restingHr: number | null;
  sleepSec: number | null;
  sleepScore: number | null;
  sleepQualifier: string | null;
  hrv: number | null;
  hrvStatus: string | null;
  stressAvg: number | null;
  bodyBatteryMax: number | null;
}

const RECOVERY_TTL_MS = 30 * 60_000;

// One day's recovery straight from Garmin Connect (sleep is filed under the
// date you woke up). Cached for 30 minutes so chat messages don't each call
// Garmin.
export async function getDayRecovery(date: string): Promise<DayRecovery | null> {
  const key = `garmin_recovery:${date}`;
  const cached = kvGet<{ at: number; data: DayRecovery }>(key);
  if (cached && Date.now() - cached.at < RECOVERY_TTL_MS) return cached.data;
  try {
    const [sleep, summary] = await Promise.all([
      garminConnectGet<{
        dailySleepDTO?: { sleepTimeSeconds?: number | null; sleepScores?: { overall?: { value?: number; qualifierKey?: string } } };
        restingHeartRate?: number | null; avgOvernightHrv?: number | null; hrvStatus?: string | null;
      }>(`/sleep-service/sleep/dailySleepData?date=${date}&nonSleepBufferMinutes=60`).catch(() => null),
      displayName()
        .then(dn => garminConnectGet<{ restingHeartRate?: number | null; averageStressLevel?: number | null; bodyBatteryHighestValue?: number | null }>(
          `/usersummary-service/usersummary/daily/${encodeURIComponent(dn)}?calendarDate=${date}`))
        .catch(() => null),
    ]);
    if (!sleep && !summary) return null;
    const overall = sleep?.dailySleepDTO?.sleepScores?.overall;
    const stress = summary?.averageStressLevel;
    const data: DayRecovery = {
      restingHr: summary?.restingHeartRate ?? sleep?.restingHeartRate ?? null,
      sleepSec: sleep?.dailySleepDTO?.sleepTimeSeconds ?? null,
      sleepScore: overall?.value ?? null,
      sleepQualifier: overall?.qualifierKey ?? null,
      hrv: sleep?.avgOvernightHrv ?? null,
      hrvStatus: sleep?.hrvStatus ?? null,
      stressAvg: stress != null && stress >= 0 ? stress : null, // Garmin uses -1/-2 for "not enough data"
      bodyBatteryMax: summary?.bodyBatteryHighestValue ?? null,
    };
    kvSet(key, { at: Date.now(), data });
    return data;
  } catch {
    return null;
  }
}
