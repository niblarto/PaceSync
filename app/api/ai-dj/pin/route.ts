import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getPinnedMix, setPinnedMix, removePinnedMix } from "@/lib/pinned-mixes";
import type { AiDjMixResponse } from "@/lib/ai-dj-mix";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const date = req.nextUrl.searchParams.get("date") ?? "";
  if (!DATE_RE.test(date)) return NextResponse.json({ error: "date required (YYYY-MM-DD)" }, { status: 400 });
  const pin = getPinnedMix(date);
  return NextResponse.json({ pinned: !!pin, workoutTitle: pin?.workoutTitle ?? null, pinnedAt: pin?.pinnedAt ?? null });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json() as {
    date?: string; workoutTitle?: string; totalSec?: number;
    timeline?: AiDjMixResponse["timeline"];
  };
  if (!body.date || !DATE_RE.test(body.date) || !body.timeline?.length) {
    return NextResponse.json({ error: "date and timeline required" }, { status: 400 });
  }
  setPinnedMix({
    date: body.date,
    workoutTitle: body.workoutTitle ?? "",
    totalSec: body.totalSec ?? 0,
    timeline: body.timeline,
    pinnedAt: new Date().toISOString(),
  });
  console.log(`[ai-dj/pin] pinned mix for ${body.date} ("${body.workoutTitle}")`);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { date } = await req.json() as { date?: string };
  if (!date || !DATE_RE.test(date)) return NextResponse.json({ error: "date required" }, { status: 400 });
  removePinnedMix(date);
  return NextResponse.json({ ok: true });
}
