import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getCsvStatus, healActiveCsv, type CsvStatus } from "@/lib/csv-heal";
import { cronNotify } from "@/lib/cron-notify";

// Overnight library heal ("heal" cron job): runs the full sweep — Spotify
// links for pending rows, audio features, durations and genres — and reports
// what changed to ntfy + the Android app. Same X-Cron-Secret-or-session auth
// as the other /api/cron/* routes.
export const maxDuration = 3600;

function gaps(s: CsvStatus) {
  const features = Math.max(0, ...Object.values(s.missingFeatures));
  return { uri: s.missingUri, duration: s.missingDuration, genres: s.missingGenres, features };
}

export async function POST(req: NextRequest) {
  const hasCronSecret = !!process.env.CRON_SECRET && req.headers.get("X-Cron-Secret") === process.env.CRON_SECRET;
  if (!hasCronSecret) {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const started = Date.now();
  try {
    const before = gaps(await getCsvStatus());
    const result = await healActiveCsv();
    const afterStatus = await getCsvStatus();
    const after = gaps(afterStatus);
    const mins = Math.max(1, Math.round((Date.now() - started) / 60000));

    const line = (label: string, b: number, a: number) => (b === a ? `${label}: ${a} missing` : `${label}: ${b} → ${a} missing`);
    const message = [
      `${result.healed} track${result.healed === 1 ? "" : "s"} updated, ${result.incomplete} still incomplete (of ${afterStatus.total}).`,
      line("Durations", before.duration, after.duration),
      line("Genres", before.genres, after.genres),
      line("Audio features", before.features, after.features),
      line("Spotify links", before.uri, after.uri),
      result.spotifyRetryAt ? `Spotify was rate-limited until ${new Date(result.spotifyRetryAt).toLocaleTimeString("en-GB")} — used Deezer/Last.fm instead.` : null,
      `Took ~${mins} min.`,
    ].filter(Boolean).join("\n");

    console.log(`[cron/heal] ${message.replace(/\n/g, " | ")}`);
    await cronNotify(message, {
      title: result.healed > 0 ? "🩹 Nightly heal done" : "🩹 Nightly heal: nothing new to fill",
      tags: "adhesive_bandage",
      type: "heal",
      priority: result.healed > 0 ? "default" : "low",
    });
    return NextResponse.json({ ok: true, before, after, ...result });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.warn("[cron/heal] failed:", error);
    await cronNotify(`Nightly heal failed: ${error}`, { title: "❌ Nightly heal failed", tags: "x", type: "sync-error", priority: "high" });
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}
