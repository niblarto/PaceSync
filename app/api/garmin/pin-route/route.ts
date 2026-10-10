import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { getPinnedRoute, setPinnedRoute, removePinnedRoute } from "@/lib/pinned-routes";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const date = req.nextUrl.searchParams.get("date") ?? "";
  const title = req.nextUrl.searchParams.get("title") ?? "";
  if (!DATE_RE.test(date) || !title) {
    return NextResponse.json({ error: "date (YYYY-MM-DD) and title required" }, { status: 400 });
  }
  return NextResponse.json({ route: getPinnedRoute(date, title) });
}

export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as {
    date?: string;
    workoutTitle?: string;
    activityId?: string | number;
    name?: string;
    distanceMi?: number;
    runDate?: string;
  };
  if (!body.date || !DATE_RE.test(body.date) || !body.workoutTitle || !body.activityId) {
    return NextResponse.json({ error: "date, workoutTitle, and activityId required" }, { status: 400 });
  }

  setPinnedRoute({
    date: body.date,
    workoutTitle: body.workoutTitle,
    activityId: String(body.activityId),
    name: body.name ?? "",
    distanceMi: body.distanceMi ?? 0,
    runDate: body.runDate ?? "",
    pinnedAt: new Date().toISOString(),
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { date, title } = await req.json() as { date?: string; title?: string };
  if (!date || !DATE_RE.test(date) || !title) {
    return NextResponse.json({ error: "date and title required" }, { status: 400 });
  }
  removePinnedRoute(date, title);
  return NextResponse.json({ ok: true });
}
