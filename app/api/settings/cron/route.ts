import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { getCronJobs, updateCronJobs, type CronJobUpdate } from "@/lib/cron-schedule";
import { getCronLog } from "@/lib/cron-log";

export const dynamic = "force-dynamic";

const VALID_KEYS = ["garmin", "weekly", "aidj", "aidjRetry", "digest"];
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

// hasApiAccess (session OR mobile bearer token) — the Android Settings
// tab's digest time/enabled control calls this with its bearer token, same
// as the other routes the app reads/writes.
export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ ...getCronJobs(), log: getCronLog() });
}

export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as { jobs?: CronJobUpdate[] };
  const jobs = body.jobs ?? [];
  const bad = jobs.find(j =>
    !VALID_KEYS.includes(j.key)
    || !TIME_RE.test(j.time)
    || (j.day !== null && (typeof j.day !== "number" || j.day < 0 || j.day > 6))
  );
  if (bad) return NextResponse.json({ error: `Invalid schedule for "${bad.key}"` }, { status: 400 });

  try {
    updateCronJobs(jobs);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
  return NextResponse.json({ ...getCronJobs(), log: getCronLog() });
}
