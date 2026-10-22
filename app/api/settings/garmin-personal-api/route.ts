import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { deleteGarminApiKey, garminApiGet, garminApiStatus, saveGarminApiKey } from "@/lib/garmin-personal-api";

export const dynamic = "force-dynamic";

// The key itself is never sent back to the browser — only whether one is saved.
export async function GET() {
  if (!(await getServerSession(authOptions))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(garminApiStatus());
}

// { apiKey } saves (and tests) a new key; { test: true } tests the saved one.
export async function POST(req: NextRequest) {
  if (!(await getServerSession(authOptions))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const b = await req.json() as { apiKey?: string; test?: boolean };
  if (b.apiKey?.trim()) saveGarminApiKey(b.apiKey);
  try {
    const today = new Date().toISOString().slice(0, 10);
    const hrv = await garminApiGet<Record<string, unknown>>(`/hrv-service/hrv/${today}`).catch(() => null);
    const recent = await garminApiGet<unknown[]>("/activitylist-service/activities/search/activities?start=0&limit=1");
    const last = Array.isArray(recent) ? recent[0] as { activityName?: string; startTimeLocal?: string } | undefined : undefined;
    return NextResponse.json({
      ok: true,
      ...garminApiStatus(),
      message: `Connected — latest activity: ${last?.activityName ?? "none"}${last?.startTimeLocal ? ` (${last.startTimeLocal.slice(0, 16)})` : ""}${hrv ? " · HRV available" : ""}`,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, ...garminApiStatus(), error: err instanceof Error ? err.message : String(err) });
  }
}

export async function DELETE() {
  if (!(await getServerSession(authOptions))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  deleteGarminApiKey();
  return NextResponse.json({ ok: true });
}
