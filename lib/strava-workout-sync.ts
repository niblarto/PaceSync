import { getFreshStravaToken, getActivity, updateActivity, listActivities, type StravaActivityDetail } from "@/lib/strava";
import { fetchRunnaSchedule, type RunnaPastRun, type RunnaWorkout } from "@/lib/runna-schedule";
import { getTodaysRunEntry, timelineToHistoryTracks } from "@/lib/todays-run-history";
import { getPinnedMix } from "@/lib/pinned-mixes";

export type SyncResult =
  | { ok: true; updated: true; workoutTitle: string }
  | { ok: true; updated: false; reason: string }
  | { ok: false; error: string };

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// A 3rd-party tool also renames new activities shortly after upload, to
// "Runna Strength Workout" or "Run X of Y" (e.g. "Run 73 of 2026"). Wait for
// that rename to land before appending the workout title — otherwise our
// update either races it (producing "X of Y — Steady into Tempo" only for
// the other tool to then overwrite it back to the bare rename) or edits the
// pre-rename placeholder name.
const RENAME_POLL_INTERVAL_MS = 15_000;
const RENAME_POLL_TIMEOUT_MS = 5 * 60_000;
const RENAME_INITIAL_DELAY_MS = 30_000;
const RENAME_PATTERNS = [/^Runna Strength Workout$/i, /^Run \d+ of \d+$/i];

// Runna's own calendar feed only flips today's run to COMPLETED_PLAN_WORKOUT
// (with the pace/distance stats findRunWorkout needs) once Runna has ingested
// the Strava upload — which can lag well behind Strava's webhook firing (seen
// taking ~35 min in practice), well past the rename-wait's 5 minutes. Poll
// longer here rather than giving up on the first "no match" fetch.
const SCHEDULE_POLL_INTERVAL_MS = 15_000;
const SCHEDULE_POLL_TIMEOUT_MS = 20 * 60_000;

async function waitForThirdPartyRename(token: string, activityId: number | string): Promise<StravaActivityDetail> {
  await sleep(RENAME_INITIAL_DELAY_MS);
  const deadline = Date.now() + RENAME_POLL_TIMEOUT_MS;
  let activity = await getActivity(token, activityId);
  while (Date.now() < deadline) {
    if (RENAME_PATTERNS.some(re => re.test(activity.name.trim()))) return activity;
    await sleep(RENAME_POLL_INTERVAL_MS);
    activity = await getActivity(token, activityId);
  }
  // Timed out — proceed with whatever name it currently has rather than
  // holding the update forever (the other tool may be slow, off, or absent).
  return activity;
}

function trackLines(date: string): string[] {
  const pinned = getPinnedMix(date);
  if (pinned) return timelineToHistoryTracks(pinned.timeline).map(t => `${t.name} — ${t.artist}`);
  const history = getTodaysRunEntry(date);
  if (!history || history.approved === false) return [];
  return history.tracks.map(t => `${t.name} — ${t.artist}`);
}

function appendTracks(description: string, tracks: string[]): string {
  if (!tracks.length) return description;
  const block = `🎧 Tracks played:\n${tracks.join("\n")}`;
  return description ? `${description}\n\n${block}` : block;
}

function findRunWorkout(pastRuns: RunnaPastRun[], date: string): RunnaPastRun | null {
  const sameDay = pastRuns.filter(r => r.date === date && r.type !== "strength");
  if (!sameDay.length) return null;
  return sameDay.reduce((a, b) => ((b.distanceMi ?? 0) > (a.distanceMi ?? 0) ? b : a));
}

// Completed strength workouts land in pastRuns too (COMPLETED_PLAN_WORKOUT-
// prefixed, just with no distance/pace/Summary block) — not in the upcoming
// `workouts` list. Fall back to `workouts` only if nothing completed exists
// yet for that date (e.g. testing against a future/unlogged session).
function findStrengthWorkout(pastRuns: RunnaPastRun[], workouts: RunnaWorkout[], date: string): RunnaPastRun | RunnaWorkout | null {
  const completed = pastRuns.find(r => r.date === date && r.type === "strength");
  if (completed) return completed;
  return workouts.find(w => w.date === date && w.type === "strength") ?? null;
}

async function syncRun(token: string, activity: StravaActivityDetail, workout: RunnaPastRun): Promise<SyncResult> {
  if (!workout.planSteps.length) {
    return { ok: true, updated: false, reason: "Matched workout has no planned steps to add" };
  }

  const alreadyApplied = activity.name.includes(workout.title);
  const newName = alreadyApplied ? activity.name : `${activity.name} — ${workout.title}`;

  const planBlock = [workout.title, ...workout.planSteps].join("\n");
  const existingDesc = (activity.description ?? "").trim();
  // Tracks are NOT appended here — that happens separately, once the user
  // confirms the playlist on the pacing review (appendTracksToStravaActivity).
  const newDescription = existingDesc.startsWith(planBlock) ? existingDesc : (
    existingDesc ? `${planBlock}\n\n${existingDesc}` : planBlock
  );

  if (newName === activity.name && newDescription === existingDesc) {
    return { ok: true, updated: false, reason: "Already up to date" };
  }
  await updateActivity(token, activity.id, { name: newName, description: newDescription });
  return { ok: true, updated: true, workoutTitle: workout.title };
}

async function syncStrength(token: string, activity: StravaActivityDetail, workout: RunnaPastRun | RunnaWorkout): Promise<SyncResult> {
  // segments/planSteps already excludes the "View in the Runna app" link line.
  const exercises = "planSteps" in workout ? workout.planSteps : workout.segments;
  if (!exercises.length) {
    return { ok: true, updated: false, reason: "Matched strength workout has no exercise list" };
  }

  const alreadyApplied = activity.name.includes(workout.title);
  const newName = alreadyApplied ? activity.name : `${activity.name} — ${workout.title}`;

  const planBlock = exercises.join("\n");
  const existingDesc = (activity.description ?? "").trim();
  // Tracks appended separately on playlist confirmation, same as runs.
  const newDescription = existingDesc.startsWith(planBlock) ? existingDesc : (
    existingDesc ? `${planBlock}\n\n${existingDesc}` : planBlock
  );

  if (newName === activity.name && newDescription === existingDesc) {
    return { ok: true, updated: false, reason: "Already up to date" };
  }
  await updateActivity(token, activity.id, { name: newName, description: newDescription });
  return { ok: true, updated: true, workoutTitle: workout.title };
}

// Applies the matching Runna workout's details to a Strava activity:
//   - Run: title appended with the workout name; description prepended with
//     the workout name + planned steps ("12mi Progressive Long Run\n4mi at a
//     conversational pace\n4mi at 9:00/mi\n...").
//   - Strength ("Workout" sport_type): same, but the plan comes from Runna's
//     upcoming-events feed (never marked "completed" the way runs are) and
//     lists the exercise sets instead of pace steps.
// The AI DJ tracklist is deliberately NOT written here: it's appended later
// by appendTracksToStravaActivity, once the user has confirmed on the pacing
// review that this really was the playlist they worked out to.
//
// Waits for a 3rd-party tool's auto-rename ("Runna Strength Workout" /
// "Run X of Y") to land first — up to 5 minutes — so our update doesn't get
// clobbered by, or race, that rename.
export async function syncWorkoutToStravaActivity(activityId: number | string, opts?: { skipWait?: boolean }): Promise<SyncResult> {
  const tokenResult = await getFreshStravaToken();
  if (!tokenResult.ok) return { ok: false, error: `Strava not connected (${tokenResult.reason})` };
  const token = tokenResult.token;

  let activity: StravaActivityDetail;
  try {
    activity = opts?.skipWait ? await getActivity(token, activityId) : await waitForThirdPartyRename(token, activityId);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to fetch activity" };
  }

  const date = activity.start_date_local.slice(0, 10);
  const isStrength = activity.sport_type === "Workout";
  if (!isStrength && activity.sport_type !== "Run") {
    return { ok: true, updated: false, reason: `Unhandled sport_type "${activity.sport_type}"` };
  }

  const deadline = Date.now() + SCHEDULE_POLL_TIMEOUT_MS;
  const notFoundReason = `No Runna ${isStrength ? "strength workout" : "run"} found for ${date}`;
  for (;;) {
    const schedule = await fetchRunnaSchedule();
    if (!schedule.ok) return { ok: false, error: schedule.error };

    try {
      if (isStrength) {
        const workout = findStrengthWorkout(schedule.pastRuns, schedule.workouts, date);
        if (workout) return await syncStrength(token, activity, workout);
      } else {
        const workout = findRunWorkout(schedule.pastRuns, date);
        if (workout) return await syncRun(token, activity, workout);
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Failed to update activity" };
    }

    if (opts?.skipWait || Date.now() >= deadline) {
      return { ok: true, updated: false, reason: notFoundReason };
    }
    await sleep(SCHEDULE_POLL_INTERVAL_MS);
  }
}

// Same day-matching heuristic as /api/garmin/activity-for-date's Strava side:
// prefer a Run, else the longest activity of any type that day.
async function findStravaActivityIdForDate(token: string, date: string): Promise<number | null> {
  const dayMs = 24 * 60 * 60 * 1000;
  const target = new Date(`${date}T12:00:00Z`).getTime();
  const activities = await listActivities(token, 30, 1, {
    after: Math.floor((target - dayMs) / 1000),
    before: Math.floor((target + dayMs) / 1000),
  });
  const sameDay = activities.filter(a => a.start_date_local.slice(0, 10) === date);
  if (!sameDay.length) return null;
  const runs = sameDay.filter(a => a.sport_type === "Run");
  const pool = runs.length ? runs : sameDay;
  const longest = pool.reduce((a, b) => (b.distance > a.distance || b.moving_time > a.moving_time ? b : a));
  return longest.id;
}

// Appends the confirmed AI DJ tracklist to the day's Strava activity —
// called when the user answers "Yes" on the pacing review's "Did you
// actually listen to this playlist?" prompt, NOT at webhook time, so only
// music that genuinely played ends up on Strava.
export async function appendTracksToStravaActivity(date: string): Promise<SyncResult> {
  const tokenResult = await getFreshStravaToken();
  if (!tokenResult.ok) return { ok: false, error: `Strava not connected (${tokenResult.reason})` };
  const token = tokenResult.token;

  const tracks = trackLines(date);
  if (!tracks.length) return { ok: true, updated: false, reason: `No confirmed mix tracks for ${date}` };

  try {
    const activityId = await findStravaActivityIdForDate(token, date);
    if (!activityId) return { ok: true, updated: false, reason: `No Strava activity found for ${date}` };

    const activity = await getActivity(token, activityId);
    const existingDesc = (activity.description ?? "").trim();
    if (existingDesc.includes("🎧 Tracks played:")) {
      return { ok: true, updated: false, reason: "Tracks already appended" };
    }
    await updateActivity(token, activityId, { description: appendTracks(existingDesc, tracks) });
    return { ok: true, updated: true, workoutTitle: activity.name };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to append tracks" };
  }
}
