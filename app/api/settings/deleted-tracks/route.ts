import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadDeletedTracks, removeFromDeletedLog } from "@/lib/deleted-tracks";

// Settings page "Deleted Tracks" tab: list every track logged as deleted,
// and let the user forget individual entries (so they can be re-imported
// without going through the BBC/CSV import review flow).

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const log = loadDeletedTracks();
  const tracks = Object.entries(log)
    .map(([uri, t]) => ({ uri, name: t.name, artist: t.artist, deletedAt: t.deletedAt }))
    .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  return NextResponse.json({ tracks });
}

export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { uris } = await req.json() as { uris?: string[] };
  if (!uris?.length) return NextResponse.json({ error: "uris required" }, { status: 400 });

  removeFromDeletedLog(uris);
  return NextResponse.json({ ok: true, removed: uris.length });
}
