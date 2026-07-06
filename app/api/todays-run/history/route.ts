import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { saveTodaysRunEntry, timelineToHistoryTracks, getTodaysRunEntry } from "@/lib/todays-run-history";
import { getPinnedMix } from "@/lib/pinned-mixes";
import type { AiDjMixResponse } from "@/lib/ai-dj-mix";

// Records which mix "Today's Run" held for a workout date (called after a
// manual "Save to Today's Running Playlist"); GET returns the snapshot.

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const date = req.nextUrl.searchParams.get("date") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "date required (YYYY-MM-DD)" }, { status: 400 });
  }
  // A pinned mix outranks the history snapshot — it's what the nightly
  // pre-build will actually put in "Today's Run" for that date.
  const pin = getPinnedMix(date);
  if (pin?.timeline?.length) {
    return NextResponse.json({
      entry: {
        date,
        workoutTitle: pin.workoutTitle,
        savedAt: pin.pinnedAt,
        tracks: timelineToHistoryTracks(pin.timeline),
        pinned: true,
      },
    });
  }
  return NextResponse.json({ entry: getTodaysRunEntry(date) });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as {
    date?: string;
    workoutTitle?: string;
    timeline?: AiDjMixResponse["timeline"];
  };
  if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date) || !body.timeline?.length) {
    return NextResponse.json({ error: "date and timeline required" }, { status: 400 });
  }

  saveTodaysRunEntry({
    date: body.date,
    workoutTitle: body.workoutTitle ?? "",
    savedAt: new Date().toISOString(),
    tracks: timelineToHistoryTracks(body.timeline),
  });
  return NextResponse.json({ ok: true });
}
