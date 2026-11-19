import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { sendCourseToGarmin } from "@/lib/garmin-course";

export const dynamic = "force-dynamic";

// Sends a route (name + points) to the user's Garmin Connect courses.
export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const b = await req.json().catch(() => ({})) as { name?: string; points?: unknown };
  const points = Array.isArray(b.points)
    ? (b.points as unknown[]).filter((p): p is number[] => Array.isArray(p) && p.length >= 2 && typeof p[0] === "number" && typeof p[1] === "number")
        .map(p => [p[0], p[1]] as [number, number])
    : [];
  if (points.length < 2) return NextResponse.json({ error: "points required" }, { status: 400 });
  const name = (b.name ?? "").trim().slice(0, 80) || "PaceSync route";
  try {
    return NextResponse.json(await sendCourseToGarmin(name, points));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
