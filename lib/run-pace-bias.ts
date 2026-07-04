import path from "path";
import { loadGarminConfig } from "@/lib/garmin-config";
import { getAllTodaysRunEntries } from "@/lib/todays-run-history";

// Closed feedback loop for easy-run intensity: compare recent easy-run songs'
// target pace against the pace actually run (GarminDB records over each
// song's play window). If the runner keeps coming in faster than target,
// return how many sec/mi to ease the next mixes by (0 = no change).

const MAX_RUNS = 5;
const EASY_TARGET_MIN_SEC = 540;      // only learn from conversational-pace songs (>= 9:00/mi target)
const DEADBAND_SEC_PER_MI = 10;       // within ±10 s/mi counts as on target
const MAX_BIAS_SEC = 30;

export function computeEasyPaceBias(): number {
  const config = loadGarminConfig();
  if (!config) return 0;

  const entries = getAllTodaysRunEntries();
  if (entries.length === 0) return 0;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(path.join(config.dbPath, "garmin_activities.db"), {
      readonly: true,
      fileMustExist: true,
    });
    db.pragma("busy_timeout = 30000");

    const errors: number[] = []; // actual - target, sec/mi (negative = too fast)
    let runsUsed = 0;

    for (let e = 0; e < entries.length && runsUsed < MAX_RUNS; e++) {
      const entry = entries[e];
      const easyTracks = entry.tracks.filter(t => t.durationSec > 0 && (t.targetPaceSec ?? 0) >= EASY_TARGET_MIN_SEC);
      if (easyTracks.length === 0) continue;

      const activity = db.prepare(`
        SELECT activity_id, start_time FROM activities
        WHERE LOWER(sport) LIKE '%running%' AND DATE(start_time) = ?
        ORDER BY distance DESC LIMIT 1
      `).get(entry.date) as { activity_id: string | number; start_time: string } | undefined;
      if (!activity) continue;

      const records = db.prepare(`
        SELECT timestamp, speed FROM activity_records
        WHERE activity_id = ? AND speed IS NOT NULL
        ORDER BY timestamp
      `).all(activity.activity_id) as { timestamp: string; speed: number }[];
      if (records.length === 0) continue;

      const startMs = new Date(activity.start_time.replace(" ", "T")).getTime();
      const samples = records
        .map(r => ({ t: (new Date(r.timestamp.replace(" ", "T")).getTime() - startMs) / 1000, mph: r.speed }))
        .filter(s => !isNaN(s.t) && s.t >= 0);
      const runEndSec = samples.length ? samples[samples.length - 1].t : 0;

      let judged = 0;
      easyTracks.forEach(t => {
        if (t.startsAtSec >= runEndSec - 15) return;
        const windowEnd = Math.min(t.startsAtSec + t.durationSec, runEndSec);
        const inWindow = samples.filter(s => s.t >= t.startsAtSec && s.t < windowEnd && s.mph > 0.5);
        if (inWindow.length < 5) return;
        const avgMph = inWindow.reduce((a, s) => a + s.mph, 0) / inWindow.length;
        errors.push(3600 / avgMph - (t.targetPaceSec as number));
        judged++;
      });
      if (judged > 0) runsUsed++;
    }
    db.close();

    if (errors.length === 0) return 0;
    const mean = errors.reduce((a, x) => a + x, 0) / errors.length;
    // Only ease down when consistently faster than the ±10 s/mi tolerance;
    // easy pace is a "no faster than" ceiling, so never speed the music up.
    if (mean >= -DEADBAND_SEC_PER_MI) return 0;
    return Math.min(MAX_BIAS_SEC, Math.round(-mean));
  } catch {
    return 0;
  }
}
