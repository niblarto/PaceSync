import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getRaceSplits, setRaceSplits, removeRaceSplits, parsePastedSplits } from "@/lib/race-splits";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const date = req.nextUrl.searchParams.get("date") ?? "";
  const title = req.nextUrl.searchParams.get("title") ?? "";
  if (!DATE_RE.test(date) || !title) {
    return NextResponse.json({ error: "date (YYYY-MM-DD) and title required" }, { status: 400 });
  }
  return NextResponse.json({ splits: getRaceSplits(date, title) });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json() as { date?: string; workoutTitle?: string; rawText?: string };
  if (!body.date || !DATE_RE.test(body.date) || !body.workoutTitle) {
    return NextResponse.json({ error: "date and workoutTitle required" }, { status: 400 });
  }
  if (!body.rawText?.trim()) {
    return NextResponse.json({ error: "rawText required" }, { status: 400 });
  }

  const parsed = parsePastedSplits(body.rawText);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const entry = {
    date: body.date,
    workoutTitle: body.workoutTitle,
    splits: parsed.splits,
    savedAt: new Date().toISOString(),
  };
  setRaceSplits(entry);
  return NextResponse.json({ ok: true, splits: entry });
}

export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { date, title } = await req.json() as { date?: string; title?: string };
  if (!date || !DATE_RE.test(date) || !title) {
    return NextResponse.json({ error: "date and title required" }, { status: 400 });
  }
  removeRaceSplits(date, title);
  return NextResponse.json({ ok: true });
}
