import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSavedPaceProMix, duplicateSavedPaceProMix } from "@/lib/pace-pro-saved";

// Clones a saved Pace Pro mix (splits + tracklist) under a new title — the
// Pace Pro page's "Duplicate" button, for building a variant of an existing
// race plan (e.g. a slower pacing strategy for the same race) without
// disturbing the original. Deliberately does NOT carry over the source's
// Spotify playlist link or attached GarminDB route — see
// duplicateSavedPaceProMix's own doc comment for why.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, title } = await req.json() as { id?: string; title?: string };
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const source = getSavedPaceProMix(id);
  if (!source) return NextResponse.json({ error: "Saved mix not found" }, { status: 404 });

  const newTitle = (title ?? `${source.title} (copy)`).trim();
  if (!newTitle) return NextResponse.json({ error: "title required" }, { status: 400 });

  const mix = duplicateSavedPaceProMix(id, newTitle);
  if (!mix) return NextResponse.json({ error: "Duplicate failed" }, { status: 500 });
  return NextResponse.json({ mix });
}
