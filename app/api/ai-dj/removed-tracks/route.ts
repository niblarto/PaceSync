import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getRemovedTracks, addRemovedTrack, clearRemovedTracks } from "@/lib/removed-tracks";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const date = req.nextUrl.searchParams.get("date") ?? "";
  const title = req.nextUrl.searchParams.get("title") ?? "";
  if (!DATE_RE.test(date) || !title) {
    return NextResponse.json({ error: "date (YYYY-MM-DD) and title required" }, { status: 400 });
  }
  return NextResponse.json({ uris: getRemovedTracks(date, title) });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { date, workoutTitle, uri } = await req.json() as { date?: string; workoutTitle?: string; uri?: string };
  if (!date || !DATE_RE.test(date) || !workoutTitle || !uri) {
    return NextResponse.json({ error: "date, workoutTitle, and uri required" }, { status: 400 });
  }
  addRemovedTrack(date, workoutTitle, uri);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { date, title } = await req.json() as { date?: string; title?: string };
  if (!date || !DATE_RE.test(date) || !title) {
    return NextResponse.json({ error: "date and title required" }, { status: 400 });
  }
  clearRemovedTracks(date, title);
  return NextResponse.json({ ok: true });
}
