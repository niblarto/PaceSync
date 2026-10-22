import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { getDb } from "@/lib/db";
import { loadGarminConfig } from "@/lib/garmin-config";
import { garminApiDownloadActivity, garminApiGet, garminApiStatus } from "@/lib/garmin-personal-api";

// Extra Garmin detail for the Coach that GarminDB lacks:
// - laps per run (warm-up / reps / rests / cool-down) from the watch's FIT
//   file — GarminDB's lap rows have empty times and distances. Uses the FIT
//   GarminDB already downloaded, else fetches it via the Personal API.
// - nightly HRV via the Personal API (GarminDB's HRV table is empty).

const PYTHON = process.platform === "win32" ? "python" : "python3";

export interface FitLap {
  intensity: string; // warmup | active | rest | recovery | cooldown | interval
  sec: number;
  m: number;
  avgHr: number | null;
  maxHr: number | null;
  spm: number | null;
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

function runFitLaps(files: Record<string, string>): Promise<Record<string, FitLap[] | { error: string }>> {
  return new Promise(resolve => {
    const proc = spawn(PYTHON, [path.join(process.cwd(), "scripts", "fit_laps.py")]);
    const timer = setTimeout(() => proc.kill(), 60_000);
    let out = "";
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("close", () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out.trim().split("\n").pop() ?? "{}")); } catch { resolve({}); }
    });
    proc.on("error", () => { clearTimeout(timer); resolve({}); });
    proc.stdin.write(JSON.stringify({ files }));
    proc.stdin.end();
  });
}

// Laps for each activity id, cached for good once read (a finished run's
// laps never change).
export async function getRunLaps(activityIds: string[]): Promise<Map<string, FitLap[]>> {
  const result = new Map<string, FitLap[]>();
  const missing: string[] = [];
  for (const id of activityIds) {
    const cached = kvGet<FitLap[]>(`coach_laps:${id}`);
    if (cached) result.set(id, cached);
    else missing.push(id);
  }
  if (!missing.length) return result;

  const config = loadGarminConfig();
  const fitDir = config ? path.join(config.dbPath, "..", "FitFiles", "Activities") : null;
  const files: Record<string, string> = {};
  const temp: string[] = [];
  const apiReady = garminApiStatus().configured;
  for (const id of missing) {
    const local = fitDir ? path.join(fitDir, `${id}_ACTIVITY.fit`) : null;
    if (local && fs.existsSync(local)) {
      files[id] = local;
    } else if (apiReady) {
      try {
        const zip = path.join(os.tmpdir(), `pacesync-${id}.zip`);
        fs.writeFileSync(zip, Buffer.from(await garminApiDownloadActivity(id)));
        files[id] = zip;
        temp.push(zip);
      } catch (err) {
        console.warn(`[coach] couldn't download activity ${id}:`, err instanceof Error ? err.message : err);
      }
    }
  }
  if (Object.keys(files).length) {
    const parsed = await runFitLaps(files);
    for (const [id, laps] of Object.entries(parsed)) {
      if (Array.isArray(laps)) {
        result.set(id, laps);
        kvSet(`coach_laps:${id}`, laps);
      } else {
        console.warn(`[coach] laps for ${id}: ${laps.error}`);
      }
    }
  }
  for (const f of temp) fs.rm(f, { force: true }, () => {});
  return result;
}

const STRUCTURED = new Set(["warmup", "rest", "recovery", "cooldown", "interval"]);

// True when the watch ran a structured workout (warm-up/rest/cool-down
// laps), i.e. the laps tell a story the overall average hides.
export function isStructured(laps: FitLap[]): boolean {
  return laps.some(l => STRUCTURED.has(l.intensity));
}

function clock(sec: number): string {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// "warm-up 1.50mi 13:20 (8:53/mi, HR 121) | rest 1:30 (HR 98) | rep 1 0.62mi 4:24 (7:05/mi, HR 144/159, 176spm) | …"
export function formatLaps(laps: FitLap[]): string {
  const structured = isStructured(laps);
  let rep = 0;
  return laps
    .filter(l => l.sec >= 15)
    .map(l => {
      const mi = l.m / 1609.344;
      const hr = l.avgHr != null ? `HR ${l.avgHr}${l.maxHr != null && l.intensity === "active" ? `/${l.maxHr}` : ""}` : "";
      if (l.intensity === "rest" || l.intensity === "recovery") {
        return `rest ${clock(l.sec)}${mi >= 0.1 ? ` ${mi.toFixed(2)}mi` : ""}${hr ? ` (${hr})` : ""}`;
      }
      const label = l.intensity === "warmup" ? "warm-up" : l.intensity === "cooldown" ? "cool-down" : `${structured ? "rep" : "lap"} ${++rep}`;
      const pace = mi > 0.05 ? `${clock(l.sec / mi)}/mi` : "";
      const bits = [pace, hr, l.spm ? `${l.spm}spm` : ""].filter(Boolean).join(", ");
      return `${label} ${mi.toFixed(2)}mi ${clock(l.sec)}${bits ? ` (${bits})` : ""}`;
    })
    .join(" | ");
}

export interface HrvDay {
  lastNightAvg: number | null;
  weeklyAvg: number | null;
  status: string | null;
  balancedLow: number | null;
  balancedUpper: number | null;
}

// Nightly HRV for a date range from the Personal API, cached for an hour.
export async function getHrvDays(fromDate: string, toDate: string, force = false): Promise<Map<string, HrvDay>> {
  const out = new Map<string, HrvDay>();
  if (!garminApiStatus().configured) return out;
  const cacheKey = "coach_hrv_cache";
  type Cache = { range: string; fetchedAt: number; days: Record<string, HrvDay> };
  const cached = kvGet<Cache>(cacheKey);
  const range = `${fromDate}/${toDate}`;
  if (!force && cached && cached.range === range && Date.now() - cached.fetchedAt < 3600_000) {
    for (const [d, v] of Object.entries(cached.days)) out.set(d, v);
    return out;
  }
  try {
    const data = await garminApiGet<{ hrvSummaries?: { calendarDate: string; lastNightAvg?: number; weeklyAvg?: number; status?: string; baseline?: { balancedLow?: number; balancedUpper?: number } }[] }>(
      `/hrv-service/hrv/daily/${fromDate}/${toDate}`,
    );
    for (const h of data.hrvSummaries ?? []) {
      out.set(h.calendarDate, {
        lastNightAvg: h.lastNightAvg ?? null,
        weeklyAvg: h.weeklyAvg ?? null,
        status: h.status ?? null,
        balancedLow: h.baseline?.balancedLow ?? null,
        balancedUpper: h.baseline?.balancedUpper ?? null,
      });
    }
    kvSet(cacheKey, { range, fetchedAt: Date.now(), days: Object.fromEntries(out) });
  } catch (err) {
    console.warn("[coach] HRV fetch failed:", err instanceof Error ? err.message : err);
    if (cached) for (const [d, v] of Object.entries(cached.days)) out.set(d, v);
  }
  return out;
}

// ── Heart-rate zones ────────────────────────────────────────────────────────
// The athlete's CURRENT zones from Garmin Connect (Personal API), so a
// change made in Garmin flows straight to the Coach. Each run's stored zone
// times use whatever zones were set when it was recorded, so time-in-zone
// is recalculated from GarminDB's second-by-second heart rate instead.

export interface HrZones {
  floors: [number, number, number, number, number]; // Z1..Z5 lower bounds, bpm
  maxHr: number | null;
  lthr: number | null;
  restingHr: number | null;
  method: string | null; // e.g. CUSTOM, LACTATE_THRESHOLD
}

const ZONES_KEY = "coach_hr_zones";

export async function getCurrentHrZones(force = false): Promise<HrZones | null> {
  type Cache = { fetchedAt: number; zones: HrZones };
  const cached = kvGet<Cache>(ZONES_KEY);
  if (!force && cached && Date.now() - cached.fetchedAt < 3600_000) return cached.zones;
  if (!garminApiStatus().configured) return cached?.zones ?? null;
  try {
    type Z = { sport?: string; trainingMethod?: string; restingHeartRateUsed?: number; lactateThresholdHeartRateUsed?: number; maxHeartRateUsed?: number; zone1Floor?: number; zone2Floor?: number; zone3Floor?: number; zone4Floor?: number; zone5Floor?: number };
    const data = await garminApiGet<Z[] | Z>("/biometric-service/heartRateZones/v2");
    const list = Array.isArray(data) ? data : [data];
    // Running zones if set, else the default ones.
    const z = list.find(x => x.sport === "RUNNING") ?? list.find(x => x.sport === "DEFAULT") ?? list[0];
    if (!z || z.zone1Floor == null || z.zone5Floor == null) return cached?.zones ?? null;
    const zones: HrZones = {
      floors: [z.zone1Floor, z.zone2Floor ?? 0, z.zone3Floor ?? 0, z.zone4Floor ?? 0, z.zone5Floor],
      maxHr: z.maxHeartRateUsed ?? null,
      lthr: z.lactateThresholdHeartRateUsed ?? null,
      restingHr: z.restingHeartRateUsed ?? null,
      method: z.trainingMethod ?? null,
    };
    kvSet(ZONES_KEY, { fetchedAt: Date.now(), zones });
    return zones;
  } catch (err) {
    console.warn("[coach] HR zones fetch failed:", err instanceof Error ? err.message : err);
    return cached?.zones ?? null;
  }
}

export function zoneOf(hr: number, zones: HrZones): number {
  for (let i = 4; i >= 0; i--) if (hr >= zones.floors[i]) return i + 1;
  return 0; // below Z1
}

// Seconds spent in Z1..Z5 per activity (index 0 = below Z1), from GarminDB's
// per-second records against `zones`. Cached per activity and zone set, so a
// zone change in Garmin recalculates everything.
export function getZoneSplits(activityIds: string[], zones: HrZones): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const sig = zones.floors.join("-");
  const missing: string[] = [];
  for (const id of activityIds) {
    const cached = kvGet<number[]>(`coach_zones:${id}:${sig}`);
    if (cached) out.set(id, cached);
    else missing.push(id);
  }
  if (!missing.length) return out;
  const config = loadGarminConfig();
  if (!config) return out;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(path.join(config.dbPath, "garmin_activities.db"), { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 30000");
    const stmt = db.prepare("SELECT timestamp, hr FROM activity_records WHERE activity_id = ? ORDER BY timestamp");
    for (const id of missing) {
      const rows = stmt.all(id) as { timestamp: string; hr: number | null }[];
      if (rows.length < 2) continue;
      const secs = [0, 0, 0, 0, 0, 0];
      for (let i = 0; i < rows.length - 1; i++) {
        const hr = rows[i].hr;
        if (hr == null) continue;
        const dt = (Date.parse(rows[i + 1].timestamp.replace(" ", "T")) - Date.parse(rows[i].timestamp.replace(" ", "T"))) / 1000;
        // Gaps over 10s are pauses or dropouts, not time in a zone.
        if (dt > 0) secs[zoneOf(hr, zones)] += Math.min(dt, 10);
      }
      out.set(id, secs);
      kvSet(`coach_zones:${id}:${sig}`, secs);
    }
    db.close();
  } catch (err) {
    console.warn("[coach] zone recalculation failed:", err instanceof Error ? err.message : err);
  }
  return out;
}

export function zonesText(z: HrZones): string {
  const f = z.floors;
  return `Z1 ${f[0]}-${f[1] - 1}, Z2 ${f[1]}-${f[2] - 1}, Z3 ${f[2]}-${f[3] - 1}, Z4 ${f[3]}-${f[4] - 1}, Z5 ${f[4]}+ bpm`;
}
