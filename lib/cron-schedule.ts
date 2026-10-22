import { execSync, spawn, spawnSync } from "child_process";

// Reads and rewrites the Pi user's crontab for the app's scheduled jobs.
// Jobs are identified by a stable substring of their command; disabling a
// job comments it out with a marker prefix so the original command survives
// a round-trip and deploy.py's install-if-missing check still sees it.

export type CronJobKey = "garmin" | "weekly" | "aidj" | "aidjRetry" | "digest" | "librarySync" | "heal" | "brokenCheck" | "coachWeekly";

export interface CronJobState {
  key: CronJobKey;
  installed: boolean;
  enabled: boolean;
  time: string;       // "HH:MM" (24h)
  day: number | null; // cron day-of-week 0–6 (0 = Sunday); null = every day
}

export interface CronJobUpdate {
  key: CronJobKey;
  enabled: boolean;
  time: string;
  day: number | null;
}

const JOB_MATCH: Record<CronJobKey, string> = {
  garmin: "garmin_run.py",
  weekly: "/api/cron/weekly",
  aidj: "/api/cron/ai-dj ", // trailing space — must NOT also match /api/cron/ai-dj-retry
  aidjRetry: "/api/cron/ai-dj-retry",
  digest: "/api/cron/digest",
  librarySync: "/api/cron/library-sync",
  heal: "/api/cron/heal",
  brokenCheck: "/api/cron/broken-tracklists",
  coachWeekly: "/api/cron/coach-weekly",
};

const OFF_PREFIX = "#PACESYNC-OFF# ";
const LINE_RE = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/;

function readCrontabLines(): string[] | null {
  try {
    return execSync("crontab -l", { encoding: "utf8" }).split("\n");
  } catch {
    return null; // no crontab command / empty crontab (e.g. dev machine)
  }
}

function findJobLine(lines: string[], key: CronJobKey): number {
  return lines.findIndex(l => l.includes(JOB_MATCH[key]));
}

function parseJob(lines: string[], key: CronJobKey): CronJobState {
  const idx = findJobLine(lines, key);
  if (idx < 0) return { key, installed: false, enabled: false, time: "00:00", day: null };
  const raw = lines[idx];
  const enabled = !raw.startsWith(OFF_PREFIX);
  const m = LINE_RE.exec(enabled ? raw : raw.slice(OFF_PREFIX.length));
  if (!m) return { key, installed: false, enabled: false, time: "00:00", day: null };
  const minute = parseInt(m[1], 10), hour = parseInt(m[2], 10);
  const dow = m[5];
  return {
    key,
    installed: true,
    enabled,
    time: `${String(isNaN(hour) ? 0 : hour).padStart(2, "0")}:${String(isNaN(minute) ? 0 : minute).padStart(2, "0")}`,
    day: dow === "*" ? null : (parseInt(dow, 10) % 7),
  };
}

export function getCronJobs(): { available: boolean; jobs: CronJobState[] } {
  const lines = readCrontabLines();
  if (lines === null) {
    return { available: false, jobs: [] };
  }
  const keys: CronJobKey[] = ["garmin", "weekly", "aidj", "aidjRetry", "digest", "librarySync", "heal", "brokenCheck", "coachWeekly"];
  return { available: true, jobs: keys.map(k => parseJob(lines, k)) };
}

export function updateCronJobs(updates: CronJobUpdate[]): void {
  const lines = readCrontabLines();
  if (lines === null) throw new Error("crontab is not available on this machine");

  updates.forEach(u => {
    const idx = findJobLine(lines, u.key);
    if (idx < 0) return; // job was never installed — nothing to reschedule

    const raw = lines[idx];
    const content = raw.startsWith(OFF_PREFIX) ? raw.slice(OFF_PREFIX.length) : raw;
    const m = LINE_RE.exec(content);
    if (!m) return;

    const [hh, mm] = u.time.split(":").map(n => parseInt(n, 10));
    const dowExpr = u.day === null ? "*" : String(u.day % 7);
    const line = `${mm} ${hh} ${m[3]} ${m[4]} ${dowExpr} ${m[6]}`;
    lines[idx] = u.enabled ? line : OFF_PREFIX + line;
  });

  const text = lines.join("\n").replace(/\n*$/, "\n");
  const res = spawnSync("crontab", ["-"], { input: text, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`crontab update failed: ${res.stderr || res.error?.message || `exit ${res.status}`}`);
  }
}

// "Run now" — fires the job's own crontab command immediately, exactly as
// cron would (same command line, same log file), detached so the request
// returns at once rather than waiting out a long job like the Garmin sync.
// Works whether or not the job is currently enabled.
export function runCronJobNow(key: CronJobKey): void {
  const lines = readCrontabLines();
  if (lines === null) throw new Error("crontab is not available on this machine");
  const idx = findJobLine(lines, key);
  if (idx < 0) throw new Error(`"${key}" isn't installed in the crontab`);
  const raw = lines[idx];
  const m = LINE_RE.exec(raw.startsWith(OFF_PREFIX) ? raw.slice(OFF_PREFIX.length) : raw);
  if (!m) throw new Error(`Couldn't read the "${key}" crontab line`);
  const child = spawn("/bin/sh", ["-c", m[6]], { detached: true, stdio: "ignore" });
  child.unref();
}

// GarminDB sync triggered by a new activity (Strava webhook): waits a couple
// of minutes so Garmin Connect has it, then runs the scheduled "garmin" job's
// own command — skipped if a sync is already running or one was triggered in
// the last 10 minutes (several uploads in a row → one sync).
const GARMIN_TRIGGER_DELAY_MS = 2 * 60 * 1000;
const GARMIN_TRIGGER_COOLDOWN_MS = 10 * 60 * 1000;
const garminTrigger = globalThis as unknown as { __garminTriggerAt?: number };
export function triggerGarminSyncSoon(reason: string): boolean {
  const now = Date.now();
  if (garminTrigger.__garminTriggerAt && now - garminTrigger.__garminTriggerAt < GARMIN_TRIGGER_COOLDOWN_MS) return false;
  garminTrigger.__garminTriggerAt = now;
  setTimeout(() => {
    try {
      const running = spawnSync("pgrep", ["-f", JOB_MATCH.garmin], { encoding: "utf8" });
      if (running.status === 0 && running.stdout.trim()) {
        console.log(`[garmin-trigger] sync already running — skipped (${reason})`);
        return;
      }
      runCronJobNow("garmin");
      console.log(`[garmin-trigger] GarminDB sync started (${reason})`);
    } catch (e) {
      console.warn("[garmin-trigger] couldn't start the GarminDB sync:", e);
    }
  }, GARMIN_TRIGGER_DELAY_MS);
  return true;
}
