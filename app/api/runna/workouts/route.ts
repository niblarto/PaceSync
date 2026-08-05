import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { fetchRunnaSchedule } from "@/lib/runna-schedule";
import { pruneStalePinsAgainstSchedule } from "@/lib/pinned-mixes";

export type { RunnaWorkout, RunnaPastRun, WorkoutType } from "@/lib/runna-schedule";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const result = await fetchRunnaSchedule();
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  // The ICS feed is the source of truth — a future-dated pinned mix whose
  // (date, title) no longer appears here (the user edited/removed that
  // slot in Runna) is stale and must be dropped, not left to linger. This
  // route is already polled every 5 minutes (client) / revalidated every 5
  // minutes (server), so it's a natural, low-frequency place to run this
  // rather than adding separate polling infrastructure just for cleanup.
  try {
    pruneStalePinsAgainstSchedule(result.workouts.map(w => ({ date: w.date, title: w.title })));
  } catch (e) {
    console.warn("[runna/workouts] stale-pin cleanup failed:", e);
  }

  return NextResponse.json({ workouts: result.workouts, pastRuns: result.pastRuns });
}
