import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getPaceProPin, setPaceProPin, removePaceProPin } from "@/lib/pace-pro-pin";
import type { AiDjMixResponse } from "@/lib/ai-dj-mix";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ pin: getPaceProPin() });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json() as {
    title?: string; totalSec?: number; timeline?: AiDjMixResponse["timeline"];
    splitsCsvText?: string; fileName?: string | null;
  };
  if (!body.title || !body.timeline?.length || !body.splitsCsvText) {
    return NextResponse.json({ error: "title, timeline, and splitsCsvText required" }, { status: 400 });
  }
  setPaceProPin({
    title: body.title,
    totalSec: body.totalSec ?? 0,
    timeline: body.timeline,
    splitsCsvText: body.splitsCsvText,
    fileName: body.fileName ?? null,
    pinnedAt: new Date().toISOString(),
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  removePaceProPin();
  return NextResponse.json({ ok: true });
}
