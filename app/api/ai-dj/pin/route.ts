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
  const title = req.nextUrl.searchParams.get("title") ?? "";
  if (!DATE_RE.test(date) || !title) {
    return NextResponse.json({ error: "date (YYYY-MM-DD) and title required" }, { status: 400 });
  }
  const pin = await getPinnedMix(date, title);
  return NextResponse.json({ pinned: !!pin, workoutTitle: pin?.workoutTitle ?? null, pinnedAt: pin?.pinnedAt ?? null });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json() as {
    date?: string; workoutTitle?: string; totalSec?: number;
    timeline?: AiDjMixResponse["timeline"]; startedAtMs?: number;
  };
  if (!body.date || !DATE_RE.test(body.date) || !body.workoutTitle) {
    return NextResponse.json({ error: "date and workoutTitle required" }, { status: 400 });
  }

  // No timeline given — re-pin: this is a saved (previously unpinned) mix
  // still on record in "Today's Run" history, being pinned again as-is.
  let timeline = body.timeline;
  let totalSec = body.totalSec ?? 0;
  if (!timeline?.length) {
    const entry = getTodaysRunEntry(body.date, body.workoutTitle);
    if (!entry?.tracks.length) {
      return NextResponse.json({ error: "date, workoutTitle, and timeline required" }, { status: 400 });
    }
    timeline = historyTracksToTimeline(entry.tracks);
    totalSec = totalSec || entry.tracks.reduce((sum, t) => sum + t.durationSec, 0);
  }

  const applied = await setPinnedMix({
    date: body.date,
    workoutTitle: body.workoutTitle,
    totalSec,
    timeline,
    pinnedAt: new Date().toISOString(),
    startedAtMs: body.startedAtMs,
  });
  if (!applied) {
    console.log(`[ai-dj/pin] rejected stale pin write for ${body.date} ("${body.workoutTitle}"), startedAtMs=${body.startedAtMs}`);
    return NextResponse.json({ ok: true, stale: true });
  }
  console.log(`[ai-dj/pin] pinned mix for ${body.date} ("${body.workoutTitle}")`);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { date, title, atMs } = await req.json() as { date?: string; title?: string; atMs?: number };
  if (!date || !DATE_RE.test(date) || !title) {
    return NextResponse.json({ error: "date and title required" }, { status: 400 });
  }
  await removePinnedMix(date, title, atMs);
  // Unpinning deletes the mix outright, not just the pin — otherwise the
  // "Today's Run" history snapshot would keep it around as a fallback and
  // the pinned-mix UI would just relabel it "saved" instead of removing it.
  removeTodaysRunEntry(date, title);
  return NextResponse.json({ ok: true });
}
