import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getFreshToken } from "@/lib/tokenStore";
import { getSpotifyUser } from "@/lib/spotify";
import { upsertPlaylist } from "@/lib/spotify-playlist";
import { buildAiDjMix } from "@/lib/ai-dj-mix";
import { loadAiDjConfig } from "@/lib/ai-dj-config";
import { fetchRunnaSchedule, TODAYS_RUN_PLAYLIST, type RunnaWorkout } from "@/lib/runna-schedule";
import { sendNtfy, trackLinkLines } from "@/lib/ntfy";
import { appendCronLog } from "@/lib/cron-log";
import { saveTodaysRunEntry, timelineToHistoryTracks } from "@/lib/todays-run-history";
import { getPinnedMix } from "@/lib/pinned-mixes";
import type { AiDjMixResponse } from "@/lib/ai-dj-mix";

// Runs daily at 15:30 (Pi local time, installed by deploy.py): if there's a
// run scheduled for tomorrow, pre-build its AI DJ mix and save it straight to
// the standing "Today's Run" playlist, so it's ready before the user wakes
// up to run it. (The dated per-workout playlist is only created when the
// user explicitly saves it from the dashboard.)

const notify = sendNtfy;

function isRunnableWorkout(w: RunnaWorkout): boolean {
  return w.type !== "strength" && w.type !== "rest" && w.segments.length > 0;
}

async function runAiDjPrebuild() {
  const config = loadAiDjConfig();
  if (!config?.enabled) {
    console.log("[cron/ai-dj] AI DJ not enabled — skipping");
    appendCronLog("AI DJ", "Skipped — AI DJ not enabled in Settings");
    return { ok: true, skipped: "AI DJ not enabled in Settings" };
  }
  if (!config.autoPlaylist) {
    console.log("[cron/ai-dj] auto playlist switched off — skipping");
    appendCronLog("AI DJ", "Skipped — auto playlist upload switched off");
    return { ok: true, skipped: "Auto playlist upload switched off in Settings" };
  }

  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const schedule = await fetchRunnaSchedule();
  if (!schedule.ok) {
    await notify(`Could not read Runna schedule: ${schedule.error}`, { title: "❌ AI DJ Pre-build Failed", tags: "x", priority: "high" });
    appendCronLog("AI DJ", `✗ Could not read Runna schedule: ${schedule.error}`);
    return { ok: false, error: schedule.error };
  }

  const tomorrowWorkouts = schedule.workouts.filter(w => w.date === tomorrow && isRunnableWorkout(w));
  if (tomorrowWorkouts.length === 0) {
    console.log(`[cron/ai-dj] no runnable workout on ${tomorrow} — skipping`);
    appendCronLog("AI DJ", `Skipped — no run scheduled for ${tomorrow}`);
    return { ok: true, skipped: `No run scheduled for ${tomorrow}` };
  }

  const tokenResult = await getFreshToken();
  if (!tokenResult.ok) {
    const msg = tokenResult.reason === "no_token_file"
      ? "No saved Spotify token — please log in at https://bpm.birch-horn.com"
      : tokenResult.reason === "refresh_failed"
        ? "Spotify token refresh failed — log in again at https://bpm.birch-horn.com"
        : "Network error reaching Spotify.";
    await notify(msg, { title: "❌ AI DJ Pre-build — Auth Failed", tags: "x", priority: "high" });
    appendCronLog("AI DJ", `✗ Spotify auth failed: ${tokenResult.reason}`);
    return { ok: false, error: tokenResult.reason };
  }
  const token = tokenResult.token;
  const user = await getSpotifyUser(token);

  const results: { title: string; ok: boolean; tracks?: number; url?: string; error?: string }[] = [];

  for (const w of tomorrowWorkouts) {
    // A mix pinned to this workout from the dashboard wins over a fresh build
    const pinned = getPinnedMix(w.date);
    let mix: AiDjMixResponse;
    if (pinned?.timeline?.length) {
      const uris: string[] = [];
      pinned.timeline.forEach(seg => seg.tracks.forEach(t => { if (t.uri) uris.push(t.uri); }));
      mix = { trackUris: uris, totalSec: pinned.totalSec, timeline: pinned.timeline };
      console.log(`[cron/ai-dj] using pinned mix for ${w.date} (pinned ${pinned.pinnedAt})`);
    } else {
      const mixResult = await buildAiDjMix(w.title, w.segments);
      if (!mixResult.ok) {
        results.push({ title: w.title, ok: false, error: mixResult.error });
        await notify(`"${w.title}" (${tomorrow}): ${mixResult.error}`, { title: "❌ AI DJ Pre-build Failed", tags: "x", priority: "high" });
        appendCronLog("AI DJ", `✗ "${w.title}": ${mixResult.error}`);
        continue;
      }
      mix = mixResult.mix;
    }
    const trackUris = mix.trackUris;
    if (!trackUris.length) {
      results.push({ title: w.title, ok: false, error: "No tracks matched this workout" });
      await notify(`"${w.title}" (${tomorrow}): no tracks matched`, { title: "❌ AI DJ Pre-build Failed", tags: "x", priority: "high" });
      appendCronLog("AI DJ", `✗ "${w.title}": no tracks matched`);
      continue;
    }

    // e.g. "12mi Long Run - 04-07-2026" — says at a glance which workout the
    // standing playlist currently holds.
    const [yy, mm, dd] = w.date.split("-");
    const description = `${w.title} - ${dd}-${mm}-${yy}`;
    try {
      const saved = await upsertPlaylist(token, user.id, TODAYS_RUN_PLAYLIST, description, trackUris);
      saveTodaysRunEntry({
        date: w.date,
        workoutTitle: w.title,
        savedAt: new Date().toISOString(),
        tracks: timelineToHistoryTracks(mix.timeline),
      });
      results.push({ title: w.title, ok: true, tracks: trackUris.length, url: saved.url });
      const trackList = trackLinkLines(
        mix.timeline.flatMap(seg => seg.tracks.map(t => ({ uri: t.uri, name: t.name, artist: t.artist })))
      );
      const pinNote = pinned ? " (pinned mix)" : "";
      await notify(
        `"${w.title}" ready for ${tomorrow} — ${trackUris.length} tracks saved as "${TODAYS_RUN_PLAYLIST}"${pinNote}\n\n${trackList}`,
        { title: pinned ? "📌 Pinned Mix Ready" : "🎧 AI DJ Mix Ready", tags: "musical_note,white_check_mark" }
      );
      appendCronLog("AI DJ", `✓ "${w.title}" (${tomorrow}) — ${trackUris.length} tracks saved to "${TODAYS_RUN_PLAYLIST}"${pinNote}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ title: w.title, ok: false, error: msg });
      await notify(`"${w.title}" (${tomorrow}): ${msg}`, { title: "❌ AI DJ Pre-build Failed", tags: "x", priority: "high" });
      appendCronLog("AI DJ", `✗ "${w.title}": ${msg}`);
    }
  }

  console.log("[cron/ai-dj] done:", results);
  return { ok: results.every(r => r.ok), date: tomorrow, results };
}

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const hasCronSecret = cronSecret && req.headers.get("X-Cron-Secret") === cronSecret;
  if (!hasCronSecret) {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runAiDjPrebuild();
    return NextResponse.json(result);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: err }, { status: 500 });
  }
}
