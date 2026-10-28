import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { execFile } from "child_process";

// The server's own log (systemd journal for this app) for the last N hours, newest first, with a level
// guess per line and secrets masked. Settings > Status shows it.
//   GET ?hours=24&level=all|warn|error&q=text&limit=1500
export const dynamic = "force-dynamic";

type Level = "info" | "warn" | "error";
interface LogLine { at: string; level: Level; msg: string }

const ERROR_RE = /⨯|\berror\b|\bfailed\b|exception|unhandled|ECONN|ETIMEDOUT|✗|\bFAILED\b/i;
const WARN_RE = /\bwarn(ing)?\b|\b429\b|rate.?limit|retry|skipp|queued|blocked|giving up|cool/i;

// Tokens and keys that might appear in a log line are masked before it leaves the server.
function redact(s: string): string {
  return s
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/((?:access_token|refresh_token|client_secret|api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"',&}]+/gi, "$1[redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]");
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const p = req.nextUrl.searchParams;
  const hours = Math.min(Math.max(Number(p.get("hours")) || 24, 1), 72);
  const levelFilter = p.get("level") ?? "all";
  const q = (p.get("q") ?? "").trim().toLowerCase();
  const limit = Math.min(Math.max(Number(p.get("limit")) || 1500, 50), 5000);

  const raw = await new Promise<string>(resolve => {
    execFile("journalctl", ["-u", "running-playlist", "--since", `${hours} hours ago`, "--no-pager", "-q", "-o", "short-iso"],
      { maxBuffer: 40 * 1024 * 1024, timeout: 20_000 }, (err, stdout) => resolve(err && !stdout ? `__ERR__${err.message}` : stdout));
  });
  if (raw.startsWith("__ERR__")) {
    return NextResponse.json({ error: `Couldn't read the server log: ${raw.slice(7)}`, lines: [], counts: { info: 0, warn: 0, error: 0 } });
  }

  const all: LogLine[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    // 2026-10-26T22:25:47+00:00 pi env[726329]: [create-playlist] ...
    const m = /^(\S+)\s+\S+\s+[^:]*?:\s?(.*)$/.exec(line);
    const at = m?.[1] ?? "";
    const msg = redact((m?.[2] ?? line).replace(/\s+$/, "")).slice(0, 600);
    const level: Level = ERROR_RE.test(msg) ? "error" : WARN_RE.test(msg) ? "warn" : "info";
    all.push({ at, level, msg });
  }
  const counts = { info: 0, warn: 0, error: 0 };
  for (const l of all) counts[l.level]++;

  let lines = all;
  if (levelFilter === "error") lines = lines.filter(l => l.level === "error");
  else if (levelFilter === "warn") lines = lines.filter(l => l.level !== "info");
  if (q) lines = lines.filter(l => l.msg.toLowerCase().includes(q));
  const total = lines.length;
  lines = lines.slice(-limit).reverse(); // newest first
  return NextResponse.json({ lines, counts, total, hours });
}
