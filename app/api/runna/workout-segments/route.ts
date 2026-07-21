import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { spawn } from "child_process";
import { join } from "path";

const PYTHON = process.platform === "win32" ? "python" : "python3";

export interface WorkoutSection {
  label: string;
  kind: "warmup" | "work" | "easy" | "cooldown" | "rest" | "strength";
  startSec: number;
  endSec: number;
  startMi: number; // planned cumulative distance — the overlay buckets by this, not elapsed time
  endMi: number;
  paceSec: number | null; // sec/mi, null for strength (no pace)
}

// Parses Runna workout segment lines (e.g. "1.5mi at 8:35/mi", "150s walking
// rest") into timed sections for the route-map overlay — same parser the AI
// DJ mixer uses (ai_dj.workout.parse_workout), via scripts/parse_workout_segments.py.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { segments } = await req.json() as { segments?: string[] };
  if (!segments?.length) return NextResponse.json({ sections: [] });

  const script = join(process.cwd(), "scripts", "parse_workout_segments.py");

  const sections = await new Promise<WorkoutSection[]>((resolve) => {
    const proc = spawn(PYTHON, [script]);
    let out = "";
    let errOut = "";
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { errOut += d.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) { console.warn("[workout-segments] parser failed:", errOut.trim()); resolve([]); return; }
      try { resolve(JSON.parse(out) as WorkoutSection[]); } catch { resolve([]); }
    });
    proc.on("error", () => resolve([]));
    proc.stdin.write(JSON.stringify({ segments }));
    proc.stdin.end();
  });

  return NextResponse.json({ sections });
}
