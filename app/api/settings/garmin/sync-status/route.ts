import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { spawnSync, spawn } from "child_process";
import fs from "fs";

const WRAPPER  = process.env.GARMINDB_SYNC_WRAPPER || "/home/pi/garmin_run.py";
const PYTHON   = process.env.GARMINDB_PYTHON_BIN    || "/home/pi/garmindb-venv/bin/python3";
const LOG_PATH = process.env.GARMINDB_LOG_PATH      || "/home/pi/garmindb_update.log";

function isSyncRunning(): boolean {
  // Use spawnSync (no shell) so the pattern never matches the check command itself
  const r = spawnSync("pgrep", ["-f", "garmindb_cli.py"], { stdio: "pipe" });
  return r.status === 0 && (r.stdout?.toString().trim().length ?? 0) > 0;
}

interface SyncProgress {
  percent: number;
  current: number;
  total: number;
  elapsed: string;
  eta: string;
  speed: string;
  section: string;
}

function parseLog(): SyncProgress | null {
  try {
    if (!fs.existsSync(LOG_PATH)) return null;
    const stat = fs.statSync(LOG_PATH);
    if (stat.size === 0) return null;

    // Read first 4KB (section headers) + last 32KB (recent tqdm lines).
    // Section headers appear at the start and don't repeat, so reading only
    // the tail misses them once the log grows beyond the read window.
    const fd = fs.openSync(LOG_PATH, "r");
    const HEAD = Math.min(4096, stat.size);
    const TAIL = Math.min(32768, Math.max(0, stat.size - HEAD));
    const headBuf = Buffer.alloc(HEAD);
    fs.readSync(fd, headBuf, 0, HEAD, 0);
    const tailBuf = Buffer.alloc(TAIL);
    if (TAIL > 0) fs.readSync(fd, tailBuf, 0, TAIL, stat.size - TAIL);
    fs.closeSync(fd);

    // latin1 avoids multi-byte decode errors from tqdm bar chars
    const lines = (headBuf.toString("latin1") + tailBuf.toString("latin1"))
      .split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);

    // tqdm line: " 11%|???| 3941/36113 [12:22<1:04:08,  8.39files/s]"
    const tqdmRe = /(\d+)%\|[^|]*\|\s*(\d+)\/(\d+)\s+\[(\d+:\d+(?::\d+)?)<([^,\]]+),\s*([^\]]+)\]/;
    const sectionRe = /^_+([^_]+)_+$|^(Getting|Analyzing|Importing)\s+(\w+)/i;

    let progress: SyncProgress | null = null;
    let section = "";

    for (const line of lines) {
      const sm = line.match(sectionRe);
      if (sm) {
        section = (sm[1] ?? `${sm[2]} ${sm[3]}`).replace(/_/g, " ").trim();
      }
      const m = line.match(tqdmRe);
      if (m) {
        progress = {
          percent:  parseInt(m[1]),
          current:  parseInt(m[2]),
          total:    parseInt(m[3]),
          elapsed:  m[4],
          eta:      m[5].trim(),
          speed:    m[6].trim()
            .replace("files/s", " files/s")
            .replace("s/files", "s/file"),
          section,
        };
      }
    }

    return progress;
  } catch {
    return null;
  }
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-9;?]*[a-zA-Z]/g;

function readLogTail(): string[] {
  try {
    if (!fs.existsSync(LOG_PATH)) return [];
    const stat = fs.statSync(LOG_PATH);
    if (stat.size === 0) return [];
    // Read 128 KB so we reach back past the tqdm spam to the section headers
    const TAIL = Math.min(131072, stat.size);
    const buf = Buffer.alloc(TAIL);
    const fd = fs.openSync(LOG_PATH, "r");
    fs.readSync(fd, buf, 0, TAIL, stat.size - TAIL);
    fs.closeSync(fd);

    const text = buf.toString("utf8").replace(ANSI_RE, "");

    // The log mixes two kinds of content:
    //   \n-terminated lines  → real descriptive text (section headers, "Processing X")
    //   \r-terminated chunks → tqdm progress bar updates (all on one \n-line)
    // Split by \n, keep only segments that contain no \r (i.e. real text lines).
    const lines = text.split("\n")
      .filter(seg => !seg.includes("\r"))
      .map(l => l.trim())
      .filter(l => l.length > 0);

    return lines.slice(-10);
  } catch {
    return [];
  }
}

function logLastModified(): string | null {
  try {
    if (!fs.existsSync(LOG_PATH)) return null;
    return fs.statSync(LOG_PATH).mtime.toISOString();
  } catch {
    return null;
  }
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const running = isSyncRunning();
  const progress = parseLog();
  const logTail = readLogTail();
  const lastRun = logLastModified();

  return NextResponse.json({ running, progress, logTail, lastRun });
}

export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (isSyncRunning()) {
    return NextResponse.json({ error: "Sync already running" }, { status: 409 });
  }

  // Launch detached so it outlives this request
  const child = spawn(PYTHON, [WRAPPER, "--all", "--download", "--import", "--analyze", "--latest"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  return NextResponse.json({ ok: true });
}
