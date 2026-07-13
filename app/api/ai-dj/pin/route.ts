import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getPinnedMix, setPinnedMix, removePinnedMix } from "@/lib/pinned-mixes";
import { getTodaysRunEntry, removeTodaysRunEntry, type HistoryTrack } from "@/lib/todays-run-history";
import type { AiDjMixResponse } from "@/lib/ai-dj-mix";

// Rebuilds a pin-shaped timeline from a saved history entry's flat track
// list, grouping consecutive tracks by segment — the inverse of
// timelineToHistoryTracks. Used to re-pin an already-saved (but unpinned)
// mix without the browser having to round-trip the full timeline shape.
function historyTracksToTimeline(tracks: HistoryTrack[]): AiDjMixResponse["timeline"] {
  const timeline: AiDjMixResponse["timeline"] = [];
  for (const t of tracks) {
    const last = timeline[timeline.length - 1];
    const track = {
      uri: t.uri ?? "", name: t.name, artist: t.artist,
      startsAt: `${String(Math.floor(t.startsAtSec / 60)).padStart(2, "0")}:${String(Math.floor(t.startsAtSec % 60)).padStart(2, "0")}`,
      durationSec: t.durationSec, tempo: t.tempo ?? 0, camelot: null, energy: t.energy ?? 0,
    };
    if (last && last.segment === t.segment) {
      last.tracks.push(track);
    } else {
      timeline.push({ segment: t.segment, targetBpm: null, targetPaceSec: t.targetPaceSec, tracks: [track] });
    }
  }
  return timeline;
}

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
  if (!body.date || !DATE_RE.test(body.date)) {
    return NextResponse.json({ error: "date required" }, { status: 400 });
  }

  // No timeline given — re-pin: this is a saved (previously unpinned) mix
  // still on record in "Today's Run" history, being pinned again as-is.
  let timeline = body.timeline;
  let workoutTitle = body.workoutTitle ?? "";
  let totalSec = body.totalSec ?? 0;
  if (!timeline?.length) {
    const entry = getTodaysRunEntry(body.date);
    if (!entry?.tracks.length) {
      return NextResponse.json({ error: "date and timeline required" }, { status: 400 });
    }
    timeline = historyTracksToTimeline(entry.tracks);
    workoutTitle = workoutTitle || entry.workoutTitle;
    totalSec = totalSec || entry.tracks.reduce((sum, t) => sum + t.durationSec, 0);
  }

  setPinnedMix({
    date: body.date,
    workoutTitle,
    totalSec,
    timeline,
    pinnedAt: new Date().toISOString(),
  });
  console.log(`[ai-dj/pin] pinned mix for ${body.date} ("${workoutTitle}")`);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { date } = await req.json() as { date?: string };
  if (!date || !DATE_RE.test(date)) return NextResponse.json({ error: "date required" }, { status: 400 });
  removePinnedMix(date);
  // Unpinning deletes the mix outright, not just the pin — otherwise the
  // "Today's Run" history snapshot would keep it around as a fallback and
  // the pinned-mix UI would just relabel it "saved" instead of removing it.
  removeTodaysRunEntry(date);
  return NextResponse.json({ ok: true });
}
