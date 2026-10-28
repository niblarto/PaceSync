import { execFileSync, spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// Settings → Backup. The backup itself is scripts/pacesync_backup.py, run by
// cron on the Pi. This module edits what that script reads: its schedule (the
// crontab line), ~/.pacesync-backup.json (share, folder, retention) and
// ~/.pacesync-backup.cred (the share login, chmod 600, never sent back out).

const HOME = os.homedir();
const CONFIG_FILE = path.join(HOME, ".pacesync-backup.json");
const CRED_FILE = path.join(HOME, ".pacesync-backup.cred");
const STATUS_FILE = path.join(HOME, ".pacesync-backup-status.json");
const LOCK_FILE = path.join(HOME, ".cache", "pacesync-backup", "lock");
const LOG_FILE = path.join(HOME, "cron-backup.log");
const MARKER = "pacesync_backup.py";

export interface BackupConfig {
  enabled: boolean;
  time: string; // HH:MM, server local time
  keepDays: number;
  host: string;
  share: string;
  folder: string;
  username: string;
}

export interface BackupStatus {
  ok: boolean;
  startedAt?: string;
  finishedAt?: string;
  seconds?: number;
  archive?: string;
  archiveBytes?: number;
  files?: number;
  daily?: number;
  shareFreeGB?: number;
  error?: string;
}

export interface BackupState extends BackupConfig {
  supported: boolean;
  hasPassword: boolean;
  running: boolean;
  nextRunAt: string | null;
  last: BackupStatus | null;
}

const DEFAULTS: Omit<BackupConfig, "enabled" | "time"> = {
  keepDays: 30, host: "192.168.0.31", share: "Backups", folder: "PaceSync", username: "",
};

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return null; }
}

function readCrontab(): string {
  try { return execFileSync("crontab", ["-l"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return ""; }
}

function writeCrontab(text: string) {
  execFileSync("crontab", ["-"], { input: text.endsWith("\n") ? text : text + "\n" });
}

// "# 15 3 * * * /usr/bin/python3 …" → schedule; disabled lines are commented out.
function backupLine(cron: string): { line: string; enabled: boolean; time: string; command: string } | null {
  for (const line of cron.split("\n")) {
    const m = line.match(/^\s*(#\s*)?(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*\s+(.*pacesync_backup\.py.*)$/);
    if (m) return { line, enabled: !m[1], time: `${m[3].padStart(2, "0")}:${m[2].padStart(2, "0")}`, command: m[4] };
  }
  return null;
}

function isRunning(): boolean {
  if (!fs.existsSync(LOCK_FILE)) return false;
  try { execFileSync("flock", ["-n", LOCK_FILE, "true"], { stdio: "ignore" }); return false; } catch { return true; }
}

function nextRun(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.toISOString();
}

function readCred(): { username: string; password: string } {
  const out = { username: "", password: "" };
  try {
    for (const l of fs.readFileSync(CRED_FILE, "utf8").split("\n")) {
      const i = l.indexOf("=");
      if (i < 0) continue;
      const k = l.slice(0, i).trim();
      if (k === "username") out.username = l.slice(i + 1).replace(/\r$/, "");
      if (k === "password") out.password = l.slice(i + 1).replace(/\r$/, "");
    }
  } catch {}
  return out;
}

export function getBackupState(): BackupState {
  const supported = process.platform === "linux";
  const cfg = readJson<Partial<BackupConfig>>(CONFIG_FILE) ?? {};
  const cred = readCred();
  const cron = supported ? backupLine(readCrontab()) : null;
  const time = cron?.time ?? "03:15";
  const enabled = !!cron?.enabled;
  return {
    supported,
    enabled,
    time,
    keepDays: cfg.keepDays ?? DEFAULTS.keepDays,
    host: cfg.host ?? DEFAULTS.host,
    share: cfg.share ?? DEFAULTS.share,
    folder: cfg.folder ?? DEFAULTS.folder,
    username: cred.username,
    hasPassword: !!cred.password,
    running: supported && isRunning(),
    nextRunAt: enabled ? nextRun(time) : null,
    last: readJson<BackupStatus>(STATUS_FILE),
  };
}

export interface BackupInput extends Partial<BackupConfig> { password?: string }

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;
const NO_BREAKS = /^[^\r\n]+$/;

export function saveBackupSettings(input: BackupInput): BackupState {
  const cur = getBackupState();
  if (!cur.supported) throw new Error("Backups only run on the Raspberry Pi server");
  const next = {
    enabled: input.enabled ?? cur.enabled,
    time: input.time ?? cur.time,
    keepDays: input.keepDays ?? cur.keepDays,
    host: (input.host ?? cur.host).trim(),
    share: (input.share ?? cur.share).trim(),
    folder: (input.folder ?? cur.folder).trim(),
    username: (input.username ?? cur.username).trim(),
  };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(next.time)) throw new Error("Time must be HH:MM");
  if (!Number.isInteger(next.keepDays) || next.keepDays < 3 || next.keepDays > 365) throw new Error("Keep between 3 and 365 days");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(next.host)) throw new Error("Server must be an IP address or host name");
  if (!SAFE_NAME.test(next.share)) throw new Error("Share name has unsupported characters");
  if (!SAFE_NAME.test(next.folder)) throw new Error("Folder name has unsupported characters");
  if (next.username && !NO_BREAKS.test(next.username)) throw new Error("Invalid username");
  if (input.password !== undefined && input.password !== "" && !NO_BREAKS.test(input.password)) throw new Error("Invalid password");

  // Share details the script reads.
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({
    keepDays: next.keepDays, host: next.host, share: next.share, folder: next.folder,
  }, null, 1), { mode: 0o600 });

  // Share login: an empty password keeps the stored one.
  const oldCred = readCred();
  const password = input.password ? input.password : oldCred.password;
  if (next.username !== oldCred.username || password !== oldCred.password) {
    fs.writeFileSync(CRED_FILE, `username=${next.username}\npassword=${password}\n`, { mode: 0o600 });
    fs.chmodSync(CRED_FILE, 0o600);
  }

  // Schedule: rewrite (or add) the one crontab line; disabled = commented out,
  // so deploy.py's "install if absent" check leaves it alone.
  const cron = readCrontab();
  const old = backupLine(cron);
  const [h, m] = next.time.split(":").map(Number);
  const command = old?.command ?? `/usr/bin/python3 ${path.join(process.cwd(), "scripts", "pacesync_backup.py")} >> ${LOG_FILE} 2>&1`;
  const line = `${next.enabled ? "" : "# "}${m} ${h} * * * ${command}`;
  const kept = cron.split("\n").filter(l => l.trim() && !(l.includes(MARKER) && /^\s*(#\s*)?\d/.test(l)));
  writeCrontab([...kept, line].join("\n"));
  return getBackupState();
}

export function runBackupNow(): BackupState {
  const cur = getBackupState();
  if (!cur.supported) throw new Error("Backups only run on the Raspberry Pi server");
  if (cur.running) throw new Error("A backup is already running");
  if (!cur.username || !cur.hasPassword) throw new Error("Enter the share's username and password first");
  const cron = backupLine(readCrontab());
  const script = cron?.command.match(/(\S*pacesync_backup\.py)/)?.[1] ?? path.join(process.cwd(), "scripts", "pacesync_backup.py");
  const log = fs.openSync(LOG_FILE, "a");
  const child = spawn("/usr/bin/python3", [script], { detached: true, stdio: ["ignore", log, log] });
  child.unref();
  return { ...cur, running: true };
}
