import fs from "fs";
import path from "path";
import { loadGarminConfig } from "@/lib/garmin-config";
import { getHrvDays, type HrvDay } from "@/lib/coach-garmin-extra";
import { getDayRecovery } from "@/lib/garmin-connect";
import { garminApiStatus } from "@/lib/garmin-personal-api";
import { loadIgnoredDates } from "@/lib/health-ignored";
import { getSleepCoach, type SleepCoach } from "@/lib/sleep-coach";

// The Health page (/health): sleep and HRV for the last month or so, from Garmin.
// Sleep (duration, stages, score) comes from GarminDB's garmin.db, which it fills in each morning; today's night, if
// GarminDB doesn't have it yet, from Garmin Connect directly. Nightly HRV (GarminDB's own HRV table is empty) comes
// from the Garmin Personal API, with its 7-day average and the baseline band Garmin judges "balanced" against.
// Sleep is filed under the day you woke up.

export interface HealthDay {
  date: string;
  sleepSec: number | null;      // total sleep (deep + light + REM)
  deepSec: number | null;
  lightSec: number | null;
  remSec: number | null;
  awakeSec: number | null;
  sleepScore: number | null;
  sleepQualifier: string | null; // "Good", "Fair", …
  hrv: number | null;            // last night's average, ms
  hrvWeekly: number | null;      // Garmin's 7-day average, ms
  hrvStatus: string | null;      // "Balanced", "Unbalanced", "Low", "Poor"
  hrvLow: number | null;         // the baseline band, ms
  hrvHigh: number | null;
  restingHr: number | null;
  ignored: boolean;              // the user has ignored this night (watch off, say): its figures are left out of everything below
}

export interface HealthAverages { sleepSec: number | null; sleepScore: number | null; hrv: number | null; restingHr: number | null; nights: number }

export interface HealthDashboard {
  today: string;
  days: HealthDay[];             // one per calendar day, oldest first, ending today (missing figures are null)
  latestSleep: HealthDay | null; // the most recent night with sleep recorded
  latestHrv: HealthDay | null;   // the most recent night with an HRV reading
  avg7: HealthAverages;
  avgAll: HealthAverages;        // over the whole range loaded
  sleepCoach: SleepCoach | null; // Garmin's Sleep Coach: how much sleep it recommends tonight, and why
  hrvAvailable: boolean;         // the Garmin Personal API is set up, so HRV can be read
  sources: { garminDb: string | null };
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

// GarminDB stores durations as clock times: "06:56:00.000000".
function timeSecs(v: string | null): number | null {
  const m = (v ?? "").match(/^(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Math.round(Number(m[3])) : null;
}

function openGarmin(file: string) {
  const config = loadGarminConfig();
  if (!config) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(path.join(config.dbPath, file), { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 30000");
    return db;
  } catch {
    return null;
  }
}

const pretty = (s: string | null | undefined) => {
  const t = (s ?? "").toLowerCase().replace(/_/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : null;
};

const mean = (xs: (number | null)[]): number | null => {
  const v = xs.filter((x): x is number => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

function averages(days: HealthDay[]): HealthAverages {
  const r = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);
  return {
    sleepSec: r(mean(days.map(d => d.sleepSec))), sleepScore: r(mean(days.map(d => d.sleepScore))),
    hrv: r(mean(days.map(d => d.hrv))), restingHr: r(mean(days.map(d => d.restingHr))), nights: days.filter(d => d.sleepSec != null).length,
  };
}

export async function buildHealthDashboard(numDays = 30): Promise<HealthDashboard> {
  const today = ymd(new Date());
  const start = addDays(today, -(numDays - 1));

  const sleep = new Map<string, Partial<HealthDay>>();
  let garminDb: string | null = null;
  const db = openGarmin("garmin.db");
  if (db) {
    try {
      const rows = db.prepare(`
        SELECT DATE(s.day) AS d, s.total_sleep, s.deep_sleep, s.light_sleep, s.rem_sleep, s.awake, s.score, s.qualifier, ds.rhr
        FROM sleep s LEFT JOIN daily_summary ds ON DATE(ds.day) = DATE(s.day)
        WHERE DATE(s.day) >= ?
      `).all(start) as { d: string; total_sleep: string | null; deep_sleep: string | null; light_sleep: string | null; rem_sleep: string | null; awake: string | null; score: number | null; qualifier: string | null; rhr: number | null }[];
      for (const r of rows) {
        sleep.set(r.d, {
          sleepSec: timeSecs(r.total_sleep), deepSec: timeSecs(r.deep_sleep), lightSec: timeSecs(r.light_sleep), remSec: timeSecs(r.rem_sleep),
          awakeSec: timeSecs(r.awake), sleepScore: r.score, sleepQualifier: pretty(r.qualifier), restingHr: r.rhr || null,
        });
      }
      // Days with no sleep row yet still may have a resting heart rate.
      const rhr = db.prepare("SELECT DATE(day) AS d, rhr FROM daily_summary WHERE DATE(day) >= ? AND rhr > 0").all(start) as { d: string; rhr: number }[];
      for (const r of rhr) if (!sleep.has(r.d)) sleep.set(r.d, { restingHr: r.rhr });
    } catch {} finally { db.close(); }
    try { garminDb = fs.statSync(path.join(loadGarminConfig()!.dbPath, "garmin.db")).mtime.toISOString(); } catch {}
  }

  const hrvAvailable = garminApiStatus().configured;
  const hrv: Map<string, HrvDay> = hrvAvailable ? await getHrvDays(start, today).catch(() => new Map<string, HrvDay>()) : new Map();

  // Today's and yesterday's night straight from Garmin Connect when GarminDB hasn't got them yet.
  const recent: Record<string, Awaited<ReturnType<typeof getDayRecovery>>> = {};
  for (const d of [addDays(today, -1), today]) {
    if (d >= start && sleep.get(d)?.sleepSec == null) recent[d] = await getDayRecovery(d).catch(() => null);
  }

  const ignoredDates = new Set(loadIgnoredDates());
  const days: HealthDay[] = [];
  for (let d = start; d <= today; d = addDays(d, 1)) {
    const s = sleep.get(d) ?? {};
    const rec = recent[d];
    const h = hrv.get(d);
    days.push({
      date: d,
      ignored: ignoredDates.has(d),
      sleepSec: s.sleepSec ?? rec?.sleepSec ?? null,
      deepSec: s.deepSec ?? null, lightSec: s.lightSec ?? null, remSec: s.remSec ?? null, awakeSec: s.awakeSec ?? null,
      sleepScore: s.sleepScore ?? rec?.sleepScore ?? null,
      sleepQualifier: s.sleepQualifier ?? pretty(rec?.sleepQualifier),
      hrv: h?.lastNightAvg ?? (rec?.hrv != null ? Math.round(rec.hrv) : null),
      hrvWeekly: h?.weeklyAvg ?? null,
      hrvStatus: pretty(h?.status ?? rec?.hrvStatus),
      hrvLow: h?.balancedLow ?? null, hrvHigh: h?.balancedUpper ?? null,
      restingHr: s.restingHr ?? rec?.restingHr ?? null,
    });
  }

  // Ignored nights count for nothing: not the latest figures, not the averages.
  const counted = days.filter(d => !d.ignored);
  const last = <K extends keyof HealthDay>(k: K) => [...counted].reverse().find(d => d[k] != null) ?? null;
  const sleepCoach = await getSleepCoach().catch(() => null);
  return {
    today, days, latestSleep: last("sleepSec"), latestHrv: last("hrv"), sleepCoach,
    avg7: averages(days.slice(-7).filter(d => !d.ignored)), avgAll: averages(counted), hrvAvailable, sources: { garminDb },
  };
}
