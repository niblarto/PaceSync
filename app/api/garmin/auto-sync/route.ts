import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { spawnSync, spawn } from "child_process";
import fs from "fs";
import path from "path";

// Triggers a GarminDB "--latest" sync the first time today's completed run
// shows up in the Runna Summary — called by the dashboard whenever it sees a
// past run dated today. Deduped per-day via a marker file so it only fires
// once (GarminDB itself may take a while to actually see the activity if
// Garmin Connect hasn't finished processing it yet, but re-triggering on
// every render would be wasteful and pointless).

const WRAPPER = process.env.GARMINDB_SYNC_WRAPPER || "/home/pi/garmin_run.py";
const PYTHON = process.env.GARMINDB_PYTHON_BIN || "/home/pi/garmindb-venv/bin/python3";
const MARKER_FILE = path.join(process.cwd(), "garmin-auto-sync-marker.json");

function isSyncRunning(): boolean {
  const r = spawnSync("pgrep", ["-f", "garmindb_cli.py"], { stdio: "pipe" });
  return r.status === 0 && (r.stdout?.toString().trim().length ?? 0) > 0;
}

function alreadyTriggeredToday(date: string): boolean {
  try {
    const data = JSON.parse(fs.readFileSync(MARKER_FILE, "utf-8")) as { date?: string };
    return data.date === date;
  } catch {
    return false;
  }
}

function markTriggered(date: string): void {
  try {
    fs.writeFileSync(MARKER_FILE, JSON.stringify({ date, at: new Date().toISOString() }), "utf-8");
  } catch { /* best-effort */ }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { date } = await req.json() as { date?: string };
  const today = new Date().toISOString().slice(0, 10);
  if (!date || date !== today) {
    return NextResponse.json({ triggered: false, reason: "not_today" });
  }
  if (alreadyTriggeredToday(date)) {
    return NextResponse.json({ triggered: false, reason: "already_triggered" });
  }
  if (isSyncRunning()) {
    // Don't mark as triggered — a sync already in flight might predate the
    // run showing up, so let a later request try again once this one ends.
    return NextResponse.json({ triggered: false, reason: "already_running" });
  }

  markTriggered(date);
  const child = spawn(PYTHON, [WRAPPER, "--all", "--download", "--import", "--analyze", "--latest"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  return NextResponse.json({ triggered: true });
}
