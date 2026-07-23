import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { recordDeletedTracks } from "@/lib/deleted-tracks";

// Excludes a track from a BBC results list before it's ever imported —
// records it in the same deleted-tracks log as a real delete, so it's
// rejected by future BBC imports (manual review prompt, or auto-rejected by
// the weekly cron) exactly like any other previously-deleted track.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { uri, name, artist } = await req.json() as { uri?: string; name?: string; artist?: string };
  if (!uri) return NextResponse.json({ error: "Missing uri" }, { status: 400 });

  recordDeletedTracks([{ uri, name, artist }]);
  return NextResponse.json({ ok: true });
}
