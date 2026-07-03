import fs from "fs";
import path from "path";

// Rolling activity log for the scheduled cron jobs, shown on the Settings
// page under Scheduled Jobs. Plain-text lines `[ISO ts] [job] message`,
// pruned to the last 48 hours on every write/read.

const FILE = path.join(process.cwd(), "cron-activity.log");
const RETAIN_MS = 48 * 60 * 60 * 1000;

export interface CronLogEntry {
  ts: string;   // ISO timestamp
  job: string;  // e.g. "BBC refresh", "AI DJ"
  message: string;
}

function readRecentLines(now: number): string[] {
  try {
    const cutoff = now - RETAIN_MS;
    return fs.readFileSync(FILE, "utf-8").split("\n").filter(l => {
      const m = /^\[([^\]]+)\]/.exec(l);
      if (!m) return false;
      const t = Date.parse(m[1]);
      return !isNaN(t) && t >= cutoff;
    });
  } catch {
    return [];
  }
}

export function appendCronLog(job: string, message: string): void {
  try {
    const now = Date.now();
    const lines = readRecentLines(now);
    lines.push(`[${new Date(now).toISOString()}] [${job}] ${message.replace(/\s*\n\s*/g, " · ")}`);
    fs.writeFileSync(FILE, lines.join("\n") + "\n", "utf-8");
  } catch (e) {
    console.warn("[cron-log] write failed:", e);
  }
}

export function getCronLog(): CronLogEntry[] {
  return readRecentLines(Date.now()).map(l => {
    const m = /^\[([^\]]+)\]\s+\[([^\]]+)\]\s+(.*)$/.exec(l);
    return m ? { ts: m[1], job: m[2], message: m[3] } : { ts: "", job: "", message: l };
  });
}
