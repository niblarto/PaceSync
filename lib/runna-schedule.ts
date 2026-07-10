import { loadRunnaUrl } from "@/lib/runna-config";

export interface RunnaWorkout {
  uid: string;
  date: string;           // YYYY-MM-DD
  summary: string;        // full summary with emoji
  title: string;          // summary without emoji prefix
  type: WorkoutType;
  distanceMi: number | null;
  durationSec: number;
  segments: string[];     // parsed from description
  appUrl: string | null;
  suggestedZone: number | null;  // 1-5, null for non-running
}

export interface RunnaPastRun {
  uid: string;
  date: string;           // YYYY-MM-DD
  title: string;
  type: WorkoutType;
  distanceMi: number | null;
  durationStr: string | null;   // e.g. "28:24"
  avgPace: string | null;       // e.g. "9:15 /mi"
  laps: string[];
  planSteps: string[];    // the original planned steps, e.g. "1.5mi at 8:35/mi"
  appUrl: string | null;
}

export type WorkoutType =
  | "easy_run" | "long_run" | "tempo" | "interval" | "race"
  | "strength" | "other_run" | "rest";

// ── ICS parser ────────────────────────────────────────────────────────────────

function unescapeIcs(s: string): string {
  return s.replace(/\\n/g, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

function parseDate(s: string): string {
  const d = s.replace(/[TZ].*$/, "").trim();
  if (d.length === 8) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  return d;
}

function extractField(block: string, field: string): string {
  const re = new RegExp(`^${field}[;:][^\r\n]*`, "m");
  const m = block.match(re);
  if (!m) return "";
  return m[0].replace(/^[^:]+:/, "").trim();
}

function classifyType(uid: string, summary: string, description: string): WorkoutType {
  const u = uid.toUpperCase();
  const s = summary.toUpperCase();
  if (u.includes("LEGS_AND_CORE") || u.includes("STRENGTH") || s.includes("🏋") || s.includes("STRENGTH")) return "strength";
  if (u.includes("LONG_RUN"))  return "long_run";
  if (u.includes("EASY_RUN"))  return "easy_run";
  if (u.includes("TEMPO"))     return "tempo";
  if (u.includes("INTERVAL") || u.includes("REPEAT") || u.includes("FARTLEK")) return "interval";
  if (u.includes("RACE"))      return "race";
  if (s.includes("🏃"))        return "other_run";
  // Untagged events (bare-GUID UID, plain-text summary like "Loading Up"):
  // everything on the Runna calendar is a run or a strength session, so fall
  // back to the description — strength plans are exercise-set lists, runs
  // always carry distance/pace text.
  if (/\d+ sets? of:/i.test(description)) return "strength";
  if (/[\d.]+\s*(mi|km)\b|\/mi|\/km/i.test(`${summary} ${description}`)) return "other_run";
  return "rest";
}

function paceSecToZone(secs: number): number {
  if (secs < 480) return 5;
  if (secs < 510) return 4;
  if (secs < 540) return 3;
  if (secs < 600) return 2;
  return 1;
}

function suggestZone(type: WorkoutType, segments: string[]): number | null {
  if (type === "strength" || type === "rest") return null;

  let fastestSecs = Infinity;
  const paceRe = /(\d+):(\d+)\/mi/g;
  for (const seg of segments) {
    let m: RegExpExecArray | null;
    paceRe.lastIndex = 0;
    while ((m = paceRe.exec(seg)) !== null) {
      const secs = parseInt(m[1]) * 60 + parseInt(m[2]);
      if (secs < fastestSecs) fastestSecs = secs;
    }
  }
  const paceZone = fastestSecs < Infinity ? paceSecToZone(fastestSecs) : 0;

  const combined = segments.join(" ").toLowerCase();
  let keywordZone = 0;
  if (/time trial|race pace|all.?out/.test(combined))    keywordZone = 5;
  else if (/threshold|tempo|lactate/.test(combined))      keywordZone = 4;
  else if (/comfortably hard|aerobic/.test(combined))     keywordZone = 3;

  const typeFloor: Partial<Record<WorkoutType, number>> = {
    tempo: 4, interval: 5, race: 5,
  };
  const floor = typeFloor[type] ?? 2;

  return Math.max(paceZone, keywordZone, floor);
}

// Runna appends a coaching aside to easy-effort steps, e.g. "...at a
// conversational pace (no faster than 9:15/mi). This is a limit, not a
// target - run at whatever pace feels truly easy!" — keep the pace clause,
// drop everything after it (both here and in Strava descriptions/titles,
// it's just noise once the step is already labeled "easy").
function stripCoachingAside(line: string): string {
  const m = line.match(/\(no faster than[^)]*\)/i);
  if (!m) return line;
  return line.slice(0, m.index! + m[0].length).trim();
}

function parseSegments(description: string): string[] {
  return description
    .split("\n")
    .map(l => stripCoachingAside(l.trim()))
    .filter(l => l && !l.startsWith("📲") && !l.startsWith("http") && l.length > 2);
}

function parseDistance(summary: string): number | null {
  const m = summary.match(/([\d.]+)mi/);
  return m ? parseFloat(m[1]) : null;
}

function stripEmoji(summary: string): string {
  // Only drop the first token if it's actually a leading emoji (Runna
  // sometimes omits it, e.g. a completed "Legs & Core Strength" with no 🏋 —
  // blindly chopping the first word off in that case truncated the title to
  // "& Core Strength").
  const i = summary.indexOf(" ");
  const firstToken = i !== -1 ? summary.slice(0, i) : "";
  const startsWithEmoji = firstToken.length > 0 && firstToken.charCodeAt(0) > 127;
  const title = startsWithEmoji ? summary.slice(i).trim() : summary;
  // Remove trailing " • Xmi" distance (redundant with the distance field)
  return title.replace(/\s*•\s*[\d.]+[a-zA-Z]+(?:\s*-\s*[\d.]+[a-zA-Z]+)?\s*$/, "").trim();
}

function isCompletedRun(uid: string, description: string): boolean {
  // The UID prefix is set by Runna regardless of workout type and is the
  // reliable signal — description.includes("Summary:") used to be the only
  // check, but strength workouts have no distance/pace/time Summary section
  // even once completed, so a completed strength day was misclassified as
  // upcoming (showing as a "Rest" card with a truncated title).
  if (uid.startsWith("COMPLETED_PLAN_WORKOUT")) return true;
  if (uid.startsWith("UPCOMING_PLAN_WORKOUT")) return false;
  return description.includes("Summary:");
}

function parsePastRunStats(description: string): Pick<RunnaPastRun, "durationStr" | "avgPace" | "laps" | "planSteps"> {
  const lines = description.split("\n").map(l => l.trim());
  let durationStr: string | null = null;
  let avgPace: string | null = null;
  const laps: string[] = [];
  const planSteps: string[] = [];
  let inLaps = false;
  let inPlan = false;

  // Stop a section at the next emoji-prefixed header line, e.g. "♻️ Laps:"
  const isSectionHeader = (line: string) => line.length > 2 && line.charCodeAt(0) > 127 && line.includes(":");

  for (const line of lines) {
    if (line.startsWith("Time:")) { durationStr = line.replace("Time:", "").trim(); continue; }
    if (line.startsWith("Avg Pace:")) { avgPace = line.replace("Avg Pace:", "").trim(); continue; }
    if (line.includes("Description:")) { inPlan = true; inLaps = false; continue; }
    if (line.includes("Laps:")) { inLaps = true; inPlan = false; continue; }
    if (inPlan) {
      if (isSectionHeader(line)) { inPlan = false; continue; }
      if (line && line !== "----------") planSteps.push(stripCoachingAside(line));
      continue;
    }
    if (inLaps) {
      if (!line || line.startsWith("📲") || line.startsWith("http")) continue;
      if (isSectionHeader(line)) { inLaps = false; continue; }
      laps.push(line);
    }
  }

  return { durationStr, avgPace, laps, planSteps };
}

function parseIcs(text: string): { workouts: RunnaWorkout[]; pastRuns: RunnaPastRun[] } {
  const blocks = text.split("BEGIN:VEVENT").slice(1);
  const today = new Date().toISOString().slice(0, 10);
  const lookback = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const cutoff = new Date(Date.now() + 28 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const workouts: RunnaWorkout[] = [];
  const pastRuns: RunnaPastRun[] = [];

  for (const block of blocks) {
    const uid        = extractField(block, "UID");
    const rawDate    = extractField(block, "DTSTART");
    const rawSummary = unescapeIcs(extractField(block, "SUMMARY"));
    const rawDesc    = unescapeIcs(extractField(block, "DESCRIPTION"));
    const durStr     = extractField(block, "X-WORKOUT-ESTIMATED-DURATION");

    const date       = parseDate(rawDate);
    const type       = classifyType(uid, rawSummary, rawDesc);
    const appUrlMatch = rawDesc.match(/https:\/\/club\.runna\.com\/\S+/);
    const appUrl     = appUrlMatch ? appUrlMatch[0] : null;

    if (isCompletedRun(uid, rawDesc) && date >= lookback && date <= today) {
      const stats = parsePastRunStats(rawDesc);
      pastRuns.push({
        uid,
        date,
        title: stripEmoji(rawSummary),
        type,
        distanceMi: parseDistance(rawSummary),
        ...stats,
        appUrl,
      });
    } else if (!isCompletedRun(uid, rawDesc) && date >= today && date <= cutoff) {
      const segments = parseSegments(rawDesc);
      workouts.push({
        uid,
        date,
        summary: rawSummary,
        title: stripEmoji(rawSummary),
        type,
        distanceMi: parseDistance(rawSummary),
        durationSec: parseInt(durStr) || 0,
        segments,
        appUrl,
        suggestedZone: suggestZone(type, segments),
      });
    }
  }

  workouts.sort((a, b) => a.date.localeCompare(b.date));
  pastRuns.sort((a, b) => b.date.localeCompare(a.date)); // most recent first

  return { workouts, pastRuns };
}

// ── Fetch + parse ────────────────────────────────────────────────────────────

export type RunnaScheduleResult =
  | { ok: true; workouts: RunnaWorkout[]; pastRuns: RunnaPastRun[] }
  | { ok: false; status: 503 | 500; error: string };

export async function fetchRunnaSchedule(): Promise<RunnaScheduleResult> {
  const url = loadRunnaUrl() ?? process.env.RUNNA_ICS_URL;
  if (!url) return { ok: false, status: 503, error: "RUNNA_ICS_URL not configured" };

  try {
    const res = await fetch(url, { next: { revalidate: 3600 } });
    if (!res.ok) throw new Error(`ICS fetch ${res.status}`);
    // Force UTF-8 decoding — the ICS server's Content-Type omits a charset,
    // and res.text() falling back to Latin-1 mangles multi-byte characters
    // like "•" (becomes "â€¢") in the exercise-list descriptions.
    const buf = await res.arrayBuffer();
    const text = new TextDecoder("utf-8").decode(buf);
    const { workouts, pastRuns } = parseIcs(text);
    return { ok: true, workouts, pastRuns };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 500, error: msg };
  }
}

// "2026-07-08" + "Steady into Tempo" -> "08-07-26 Steady into Tempo"
export function mixPlaylistName(w: Pick<RunnaWorkout, "date" | "title">): string {
  const [y, m, d] = w.date.split("-");
  return `${d}-${m}-${y.slice(2)} ${w.title}`;
}

export const TODAYS_RUN_PLAYLIST = "Today's Run";
