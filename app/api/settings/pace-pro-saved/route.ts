import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { listSavedPaceProMixes, saveSavedPaceProMix, deleteSavedPaceProMix, getSavedPaceProMix } from "@/lib/pace-pro-saved";
import type { AiDjMixResponse } from "@/lib/ai-dj-mix";

// ?id=<mixId> returns just that one mix (e.g. RunnaCard.tsx's route map
// resolving a linked Pace Pro mix's own tracklist) instead of the whole
// library — no id returns the full list, same as before.
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = req.nextUrl.searchParams.get("id");
  if (id) {
    const mix = getSavedPaceProMix(id);
    if (!mix) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ mix });
  }
  return NextResponse.json({ mixes: listSavedPaceProMixes() });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json() as {
    id?: string; title?: string; totalSec?: number; timeline?: AiDjMixResponse["timeline"];
    splitsCsvText?: string; fileName?: string | null;
  };
  if (!body.title || !body.timeline?.length || !body.splitsCsvText) {
    return NextResponse.json({ error: "title, timeline, and splitsCsvText required" }, { status: 400 });
  }
  const mix = saveSavedPaceProMix({
    id: body.id,
    title: body.title,
    totalSec: body.totalSec ?? 0,
    timeline: body.timeline,
    splitsCsvText: body.splitsCsvText,
    fileName: body.fileName ?? null,
  });
  return NextResponse.json({ mix });
}

export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  deleteSavedPaceProMix(id);
  return NextResponse.json({ ok: true });
}
