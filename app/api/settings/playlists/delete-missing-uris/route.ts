import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { activeCsvPath } from "@/lib/running-playlist-config";
import { readCsv, writeCsv } from "@/lib/csv-store";

// Removes every row in the active playlist's CSV that has no Track URI at
// all — these were never matched to Spotify, so there's nothing to
// unfollow/remove there; this is a local-library-only cleanup. Distinct
// from /api/tracks/delete, which matches by URI and so can't target these
// rows in the first place.
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const csvPath = activeCsvPath();
  const { headers, rows, col } = await readCsv(csvPath);
  const idxUri = col("Track URI");
  if (idxUri === -1) return NextResponse.json({ error: "Library CSV is missing a Track URI column" }, { status: 500 });

  const kept = rows.filter(row => !!row[idxUri]?.trim());
  const removed = rows.length - kept.length;
  if (removed > 0) await writeCsv(csvPath, headers, kept);

  return NextResponse.json({ ok: true, removed });
}
