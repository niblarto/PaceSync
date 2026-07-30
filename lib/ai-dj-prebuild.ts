import { getFreshToken } from "@/lib/tokenStore";
import { getSpotifyUser } from "@/lib/spotify";
import { upsertPlaylist } from "@/lib/spotify-playlist";
import { buildAiDjMix } from "@/lib/ai-dj-mix";
import { loadAiDjConfig } from "@/lib/ai-dj-config";
import { fetchRunnaSchedule, TODAYS_RUN_PLAYLIST, type RunnaWorkout } from "@/lib/runna-schedule";
import { sendNtfy, trackLinkLines } from "@/lib/ntfy";
import { appendCronLog } from "@/lib/cron-log";
import { saveTodaysRunEntry, getTodaysRunEntry, timelineToHistoryTracks } from "@/lib/todays-run-history";
import { getPinnedMix } from "@/lib/pinned-mixes";
import type { AiDjMixResponse } from "@/lib/ai-dj-mix";

// Shared by two cron schedules (app/api/cron/ai-dj/route.ts at 15:30 for
// TOMORROW, app/api/cron/ai-dj-retry/route.ts at 06:00 for TODAY):
// - Evening pre-build: targets tomorrow's workout so the mix is ready before
//   the user wakes up to run it.
// - Morning retry: targets today's workout. The evening job only ever gets
//   one shot at 15:30 against whatever the ICS feed says right then — if
//   Runna hadn't yet published or later reshuffled that workout, it was
//   permanently skipped with no backfill (confirmed against real history:
//   several completed runs had no saved tracklist at all). The morning retry
//   re-checks with a full night's more-settled schedule data and only builds
//   workouts that still have nothing saved (see the getPinnedMix/
//   getTodaysRunEntry check below) — a no-op on a day the evening job
//   already succeeded, a real second chance on a day it didn't.
//
// Either way, the built mix is saved straight to the standing "Today's Run"
// playlist. (The dated per-workout playlist is only created when the user
// explicitly saves it from the dashboard.)

const notify = sendNtfy;

function isRunnableWorkout(w: RunnaWorkout): boolean {
  if (w.type === "rest") return false;
  if (w.type === "strength") return w.durationSec > 0;
  return w.segments.length > 0;
}

// Strength sessions have no pace segments — synthesize one the mixer's
// strength kind understands (high energy, any BPM, session-length budget).
// durationSec comes straight from Runna's ICS estimate, which is occasionally
// missing/wrong for strength sessions — clamp to a sane range so a bad value
// can't produce a runaway-length mix.
const STRENGTH_MIN_SEC = 10 * 60;
const STRENGTH_MAX_SEC = 90 * 60;
function mixSegmentsFor(w: RunnaWorkout): string[] {
  if (w.type !== "strength") return w.segments;
  const raw = w.durationSec;
  const clamped = Math.min(Math.max(raw || 45 * 60, STRENGTH_MIN_SEC), STRENGTH_MAX_SEC);
  if (raw !== clamped) {
    console.warn(`[cron/ai-dj] strength duration ${raw}s out of range — using ${clamped}s`);
  }
  const mins = Math.round(clamped / 60);
  // The "•"-delimited line lets the mixer parse this as the target duration
  // (same as a run's "Long Run • 13.1mi • 1h50m - 2h10m" summary) instead of
  // falling back to a fixed +5min pad, which let mixes overshoot the session.
  return [`Strength • ${mins}m - ${mins}m`, `${mins} min strength session`];
}

export async function buildAndSaveMixesFor(targetDate: string, label: "pre-build" | "morning retry") {
  const config = loadAiDjConfig();
  if (!config?.enabled) {
    console.log(`[cron/ai-dj] AI DJ not enabled — skipping (${label})`);
    appendCronLog("AI DJ", `Skipped (${label}) — AI DJ not enabled in Settings`);
    return { ok: true, skipped: "AI DJ not enabled in Settings" };
  }
  if (!config.autoPlaylist) {
    console.log(`[cron/ai-dj] auto playlist switched off — skipping (${label})`);
    appendCronLog("AI DJ", `Skipped (${label}) — auto playlist upload switched off`);
    return { ok: true, skipped: "Auto playlist upload switched off in Settings" };
  }

  const schedule = await fetchRunnaSchedule();
  if (!schedule.ok) {
    await notify(`Could not read Runna schedule: ${schedule.error}`, { title: "❌ AI DJ Pre-build Failed", tags: "x", priority: "high" });
    appendCronLog("AI DJ", `✗ (${label}) Could not read Runna schedule: ${schedule.error}`);
    return { ok: false, error: schedule.error };
  }

  let targetWorkouts = schedule.workouts.filter(w => w.date === targetDate && isRunnableWorkout(w));

  // Morning retry only: don't rebuild/overwrite a workout the evening job (or
  // a manual save) already covered — only fill genuinely empty slots.
  if (label === "morning retry") {
    targetWorkouts = targetWorkouts.filter(w => !getPinnedMix(w.date, w.title) && !getTodaysRunEntry(w.date, w.title));
  }

  if (targetWorkouts.length === 0) {
    console.log(`[cron/ai-dj] no runnable (uncovered) workout on ${targetDate} — skipping (${label})`);
    appendCronLog("AI DJ", `Skipped (${label}) — no run scheduled for ${targetDate}`);
    return { ok: true, skipped: `No run scheduled for ${targetDate}` };
  }

  const tokenResult = await getFreshToken();
  if (!tokenResult.ok) {
    const msg = tokenResult.reason === "no_token_file"
      ? "No saved Spotify token — please log in at https://bpm.birch-horn.com"
      : tokenResult.reason === "refresh_failed"
        ? "Spotify token refresh failed — log in again at https://bpm.birch-horn.com"
        : "Network error reaching Spotify.";
    await notify(msg, { title: "❌ AI DJ Pre-build — Auth Failed", tags: "x", priority: "high" });
    appendCronLog("AI DJ", `✗ (${label}) Spotify auth failed: ${tokenResult.reason}`);
    return { ok: false, error: tokenResult.reason };
  }
  const token = tokenResult.token;
  const user = await getSpotifyUser(token);

  const results: { title: string; ok: boolean; tracks?: number; url?: string; error?: string }[] = [];

  for (const w of targetWorkouts) {
    // A mix pinned to this workout from the dashboard wins over a fresh build
    const pinned = getPinnedMix(w.date, w.title);
    let mix: AiDjMixResponse;
    if (pinned?.timeline?.length) {
      const uris: string[] = [];
      pinned.timeline.forEach(seg => seg.tracks.forEach(t => { if (t.uri) uris.push(t.uri); }));
      mix = { trackUris: uris, totalSec: pinned.totalSec, timeline: pinned.timeline };
      console.log(`[cron/ai-dj] using pinned mix for ${w.date} (pinned ${pinned.pinnedAt})`);
    } else {
      const mixResult = await buildAiDjMix(w.title, mixSegmentsFor(w));
      if (!mixResult.ok) {
        results.push({ title: w.title, ok: false, error: mixResult.error });
        await notify(`"${w.title}" (${targetDate}): ${mixResult.error}`, { title: "❌ AI DJ Pre-build Failed", tags: "x", priority: "high" });
        appendCronLog("AI DJ", `✗ (${label}) "${w.title}": ${mixResult.error}`);
        continue;
      }
      mix = mixResult.mix;
    }
    const trackUris = mix.trackUris;
    if (!trackUris.length) {
      results.push({ title: w.title, ok: false, error: "No tracks matched this workout" });
      await notify(`"${w.title}" (${targetDate}): no tracks matched`, { title: "❌ AI DJ Pre-build Failed", tags: "x", priority: "high" });
      appendCronLog("AI DJ", `✗ (${label}) "${w.title}": no tracks matched`);
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
        `"${w.title}" ready for ${targetDate} — ${trackUris.length} tracks saved as "${TODAYS_RUN_PLAYLIST}"${pinNote}\n\n${trackList}`,
        { title: pinned ? "📌 Pinned Mix Ready" : "🎧 AI DJ Mix Ready", tags: "musical_note,white_check_mark" }
      );
      appendCronLog("AI DJ", `✓ (${label}) "${w.title}" (${targetDate}) — ${trackUris.length} tracks saved to "${TODAYS_RUN_PLAYLIST}"${pinNote}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ title: w.title, ok: false, error: msg });
      await notify(`"${w.title}" (${targetDate}): ${msg}`, { title: "❌ AI DJ Pre-build Failed", tags: "x", priority: "high" });
      appendCronLog("AI DJ", `✗ (${label}) "${w.title}": ${msg}`);
    }
  }

  console.log(`[cron/ai-dj] done (${label}):`, results);
  return { ok: results.every(r => r.ok), date: targetDate, results };
}
