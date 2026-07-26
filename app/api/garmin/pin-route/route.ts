import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getPinnedRoute, setPinnedRoute, removePinnedRoute } from "@/lib/pinned-routes";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const date = req.nextUrl.searchParams.get("date") ?? "";
  if (!DATE_RE.test(date)) return NextResponse.json({ error: "date required (YYYY-MM-DD)" }, { status: 400 });
  return NextResponse.json({ route: getPinnedRoute(date) });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as {
    date?: string;
    activityId?: string | number;
    name?: string;
    distanceMi?: number;
    runDate?: string;
  };
  if (!body.date || !DATE_RE.test(body.date) || !body.activityId) {
    return NextResponse.json({ error: "date and activityId required" }, { status: 400 });
  }

  setPinnedRoute({
    date: body.date,
    activityId: String(body.activityId),
    name: body.name ?? "",
    distanceMi: body.distanceMi ?? 0,
    runDate: body.runDate ?? "",
    pinnedAt: new Date().toISOString(),
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { date } = await req.json() as { date?: string };
  if (!date || !DATE_RE.test(date)) return NextResponse.json({ error: "date required" }, { status: 400 });
  removePinnedRoute(date);
  return NextResponse.json({ ok: true });
}
