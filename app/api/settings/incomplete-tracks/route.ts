import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { scanActiveCsvAll } from "@/lib/csv-heal";

// Per-track breakdown of every field the heal sweep tracks (BPM/duration/
// energy AND genres) that's missing from the active playlist's CSV —
// broader than scanActiveCsv (which app/api/ai-dj/mix's pre-build warning
// uses and deliberately excludes genre-only gaps, since those don't affect
// mix-building). This route backs the Settings tracklist page's "Tracks
// with errors" section, which is about library completeness generally.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { incomplete } = await scanActiveCsvAll().catch(() => ({ checked: 0, incomplete: [] }));
  return NextResponse.json({ tracks: incomplete });
}
