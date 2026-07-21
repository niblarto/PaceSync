import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { healActiveCsv, getCsvStatus, markHealStarting } from "@/lib/csv-heal";

// Manual trigger for the Settings page's "Check for missing data" button —
// same sweep that runs automatically after every CSV write (lib/csv-heal.ts):
// ReccoBeats/Deezer for audio features and genres first (never touches
// Spotify), then Spotify for Duration with a 429 check before every call —
// a long rate limit stops further Spotify use for the rest of the sweep
// and falls through to Deezer/Last.fm. Runs in the background; the client
// polls /api/settings/heal-status (already wired to the progress bar) for
// updates. Returns the instant column-blank breakdown immediately so the
// button shows what's missing before the (slower) sweep even starts.
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const status = await getCsvStatus().catch(() => null);
  // Written before the sweep's own progress writes land, so the client's
  // very next poll sees "running" instead of a stale finished-sweep file.
  await markHealStarting();
  void healActiveCsv().catch(e => console.warn("[settings/heal-now]", e));
  return NextResponse.json({ ok: true, status });
}
