import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { hasApiAccess } from "@/lib/mobile-auth";
import { authOptions } from "@/lib/auth";
import { getSavedPaceProMix } from "@/lib/pace-pro-saved";
import { getRacePaceProMixId } from "@/lib/race-pace-pro-link";
import { getPinnedRoute } from "@/lib/pinned-routes";
import { getRaceSplits, setRaceSplits, removeRaceSplits, parsePastedSplits } from "@/lib/race-splits";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  // Also open to the Android app's bearer token (it shows the pinned Pace Pro tracklist).
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const date = req.nextUrl.searchParams.get("date") ?? "";
  const title = req.nextUrl.searchParams.get("title") ?? "";
  if (!DATE_RE.test(date) || !title) {
    return NextResponse.json({ error: "date (YYYY-MM-DD) and title required" }, { status: 400 });
  }
  // The Pace Pro mix pinned to this race (if any), with its tracklist for the card.
  // Races linked before the tracklist had its own pin still carry the mix on their pinned route.
  const mixId = getRacePaceProMixId(date, title) ?? getPinnedRoute(date, title)?.paceProMixId ?? null;
  const mix = mixId ? getSavedPaceProMix(mixId) : null;
  const paceProMix = mix ? {
    id: mix.id, title: mix.title, totalSec: mix.totalSec,
    tracks: mix.timeline.flatMap(s => s.tracks.map(t => ({ uri: t.uri, name: t.name, artist: t.artist, startsAt: t.startsAt, durationSec: t.durationSec ?? null, segment: s.segment, tempo: t.tempo, energy: t.energy }))),
  } : null;
  return NextResponse.json({ splits: getRaceSplits(date, title), paceProMix });
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
