import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { fetchRunnaSchedule } from "@/lib/runna-schedule";

export type { RunnaWorkout, RunnaPastRun, WorkoutType } from "@/lib/runna-schedule";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const result = await fetchRunnaSchedule();
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ workouts: result.workouts, pastRuns: result.pastRuns });
}
