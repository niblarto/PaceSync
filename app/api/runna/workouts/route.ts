import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
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

export type WorkoutType =
  | "easy_run" | "long_run" | "tempo" | "interval" | "race"
  | "strength" | "other_run" | "rest";

// ── ICS parser ────────────────────────────────────────────────────────────────

function unescapeIcs(s: string): string {
  return s.replace(/\\n/g, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

function parseDate(s: string): string {
  // YYYYMMDD → YYYY-MM-DD
  const d = s.replace(/[TZ].*$/, "").trim();
  if (d.length === 8) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  return d;
}

function extractField(block: string, field: string): string {
  const re = new RegExp(`^${field}[;:][^\r\n]*`, "m");
  const m = block.match(re);
  if (!m) return "";
  // strip the field name + any params (e.g. DTSTART;TZID=...)
  return m[0].replace(/^[^:]+:/, "").trim();
}

function classifyType(uid: string, summary: string): WorkoutType {
  const u = uid.toUpperCase();
  const s = summary.toUpperCase();
  if (u.includes("LEGS_AND_CORE") || u.includes("STRENGTH") || s.includes("🏋")) return "strength";
  if (u.includes("LONG_RUN"))  return "long_run";
  if (u.includes("EASY_RUN"))  return "easy_run";
  if (u.includes("TEMPO"))     return "tempo";
  if (u.includes("INTERVAL") || u.includes("REPEAT") || u.includes("FARTLEK")) return "interval";
  if (u.includes("RACE"))      return "race";
  if (s.includes("🏃"))        return "other_run";
  return "rest";
}

function paceSecToZone(secs: number): number {
  if (secs < 480) return 5;  // faster than 8:00/mi
  if (secs < 510) return 4;  // 8:00–8:29/mi
  if (secs < 540) return 3;  // 8:30–8:59/mi
  if (secs < 600) return 2;  // 9:00–9:59/mi
  return 1;
}

function suggestZone(type: WorkoutType, segments: string[]): number | null {
  if (type === "strength" || type === "rest") return null;

  // Fastest explicit pace across all segments
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

  // Keyword hints from description
  const combined = segments.join(" ").toLowerCase();
  let keywordZone = 0;
  if (/time trial|race pace|all.?out/.test(combined))    keywordZone = 5;
  else if (/threshold|tempo|lactate/.test(combined))      keywordZone = 4;
  else if (/comfortably hard|aerobic/.test(combined))     keywordZone = 3;

  // Type-based floor (intervals/race are always hard regardless of stated paces)
  const typeFloor: Partial<Record<WorkoutType, number>> = {
    tempo: 4, interval: 5, race: 5,
  };
  const floor = typeFloor[type] ?? 2;

  return Math.max(paceZone, keywordZone, floor);
}

function parseSegments(description: string): string[] {
  return description
    .split("\n")
    .map(l => l.trim())
    .filter(l => l && !l.startsWith("📲") && !l.startsWith("http") && l.length > 2);
}

function parseDistance(summary: string): number | null {
  const m = summary.match(/([\d.]+)mi/);
  return m ? parseFloat(m[1]) : null;
}

function stripEmoji(summary: string): string {
  // All Runna summaries start with a single emoji word then a space
  const i = summary.indexOf(" ");
  return i !== -1 ? summary.slice(i).trim() : summary;
}

function parseIcs(text: string): RunnaWorkout[] {
  const blocks = text.split("BEGIN:VEVENT").slice(1);
  const today = new Date().toISOString().slice(0, 10);
  const cutoff = new Date(Date.now() + 28 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  return blocks
    .map(block => {
      const uid         = extractField(block, "UID");
      const rawDate     = extractField(block, "DTSTART");
      const rawSummary  = unescapeIcs(extractField(block, "SUMMARY"));
      const rawDesc     = unescapeIcs(extractField(block, "DESCRIPTION"));
      const durStr      = extractField(block, "X-WORKOUT-ESTIMATED-DURATION");

      const date        = parseDate(rawDate);
      const type        = classifyType(uid, rawSummary);
      const segments    = parseSegments(rawDesc);
      const appUrlMatch = rawDesc.match(/https:\/\/club\.runna\.com\/\S+/);

      return {
        uid,
        date,
        summary: rawSummary,
        title: stripEmoji(rawSummary),
        type,
        distanceMi: parseDistance(rawSummary),
        durationSec: parseInt(durStr) || 0,
        segments,
        appUrl: appUrlMatch ? appUrlMatch[0] : null,
        suggestedZone: suggestZone(type, segments),
      } satisfies RunnaWorkout;
    })
    .filter(w => w.date >= today && w.date <= cutoff)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = loadRunnaUrl() ?? process.env.RUNNA_ICS_URL;
  if (!url) return NextResponse.json({ error: "RUNNA_ICS_URL not configured" }, { status: 503 });

  try {
    const res = await fetch(url, { next: { revalidate: 3600 } });
    if (!res.ok) throw new Error(`ICS fetch ${res.status}`);
    const text = await res.text();
    const workouts = parseIcs(text);
    return NextResponse.json({ workouts });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
