import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { saveTodaysRunEntry, timelineToHistoryTracks, getTodaysRunEntry, setTodaysRunApproval, removeTodaysRunEntry } from "@/lib/todays-run-history";
import { getPinnedMix, setPinnedMix, removePinnedMix } from "@/lib/pinned-mixes";
import { appendTracksToStravaActivity } from "@/lib/strava-workout-sync";
import type { AiDjMixResponse } from "@/lib/ai-dj-mix";

// Records which mix "Today's Run" held for a workout date+title (see
// lib/workout-key.ts — called after a manual "Save to Today's Running
// Playlist"); GET returns the snapshot.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const date = req.nextUrl.searchParams.get("date") ?? "";
  const title = req.nextUrl.searchParams.get("title") ?? "";
  if (!DATE_RE.test(date) || !title) {
    return NextResponse.json({ error: "date (YYYY-MM-DD) and title required" }, { status: 400 });
  }
  // A pinned mix outranks the history snapshot — it's what the nightly
  // pre-build will actually put in "Today's Run" for that date.
  const pin = getPinnedMix(date, title);
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
  return NextResponse.json({ entry: getTodaysRunEntry(date, title) });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as {
    date?: string;
    workoutTitle?: string;
    timeline?: AiDjMixResponse["timeline"];
  };
  if (!body.date || !DATE_RE.test(body.date) || !body.workoutTitle || !body.timeline?.length) {
    return NextResponse.json({ error: "date, workoutTitle, and timeline required" }, { status: 400 });
  }

  saveTodaysRunEntry({
    date: body.date,
    workoutTitle: body.workoutTitle,
    savedAt: new Date().toISOString(),
    tracks: timelineToHistoryTracks(body.timeline),
  });

  // A pinned mix outranks the saved snapshot everywhere (history GET, the
  // nightly pre-build) — so an explicit save over a pinned date replaces the
  // pin's content with this mix, rather than letting the stale pin win. The
  // pin is updated (not removed) so the cron re-applies *this* mix instead
  // of auto-building a different one.
  const pin = getPinnedMix(body.date, body.workoutTitle);
  if (pin) {
    const totalSec = body.timeline.reduce(
      (sum, seg) => sum + seg.tracks.reduce((s, t) => s + (t.durationSec ?? 0), 0), 0);
    setPinnedMix({
      date: body.date,
      workoutTitle: body.workoutTitle,
      totalSec,
      timeline: body.timeline,
      pinnedAt: new Date().toISOString(),
    });
    console.log(`[todays-run] replaced pinned mix for ${body.date} ("${body.workoutTitle}") with the newly saved mix`);
  }
  return NextResponse.json({ ok: true });
}

// Deletes a saved (unpinned) mix outright — also removes any pin for that
// workout, so this works as a full delete regardless of pin state.
export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { date, title } = await req.json() as { date?: string; title?: string };
  if (!date || !DATE_RE.test(date) || !title) {
    return NextResponse.json({ error: "date and title required" }, { status: 400 });
  }
  removeTodaysRunEntry(date, title);
  removePinnedMix(date, title);
  return NextResponse.json({ ok: true });
}

// Confirm/deny whether the saved mix was actually what played that day.
export async function PATCH(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as { date?: string; title?: string; approved?: boolean };
  if (!body.date || !DATE_RE.test(body.date) || !body.title || typeof body.approved !== "boolean") {
    return NextResponse.json({ error: "date, title, and approved required" }, { status: 400 });
  }
  const entry = setTodaysRunApproval(body.date, body.title, body.approved);
  if (!entry) return NextResponse.json({ error: "No saved mix for that date" }, { status: 404 });

  // Playlist confirmed — now (and only now) append the tracklist to the
  // day's Strava activity. Fire-and-forget: the approval itself shouldn't
  // block on (or fail because of) Strava.
  if (body.approved === true) {
    const date = body.date;
    const title = body.title;
    appendTracksToStravaActivity(date, title)
      .then(result => {
        if (!result.ok) console.warn(`[todays-run] Strava track append failed for ${date}: ${result.error}`);
        else if (result.updated) console.log(`[todays-run] appended tracks to Strava activity for ${date}`);
        else console.log(`[todays-run] Strava tracks not appended for ${date}: ${result.reason}`);
      })
      .catch(e => console.warn(`[todays-run] Strava track append threw for ${date}:`, e));
  }

  return NextResponse.json({ ok: true });
}
