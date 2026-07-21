import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { findPreviouslyDeleted } from "@/lib/deleted-tracks";

// Which of these URIs were previously deleted from the library? Import
// flows call this BEFORE adding anything (to Spotify or the CSV) so
// previously-deleted tracks can be reviewed/overridden up front.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { uris } = await req.json() as { uris?: string[] };
  if (!uris?.length) return NextResponse.json({ rejected: [] });

  const hits = findPreviouslyDeleted(uris);
  const rejected = Object.entries(hits).map(([uri, d]) => ({ uri, name: d.name, artist: d.artist, deletedAt: d.deletedAt }));
  return NextResponse.json({ rejected });
}
