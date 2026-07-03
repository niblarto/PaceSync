import { execSync, spawnSync } from "child_process";

// Reads and rewrites the Pi user's crontab for the app's scheduled jobs.
// Jobs are identified by a stable substring of their command; disabling a
// job comments it out with a marker prefix so the original command survives
// a round-trip and deploy.py's install-if-missing check still sees it.

export type CronJobKey = "garmin" | "weekly" | "aidj";

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
  aidj: "/api/cron/ai-dj",
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
  const keys: CronJobKey[] = ["garmin", "weekly", "aidj"];
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
