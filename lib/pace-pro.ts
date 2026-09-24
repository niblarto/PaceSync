// Garmin PacePro plan export: a CSV of "Splits,Split Distance,Split Pace"
// rows, one per race split (e.g. auto-lap or manually defined pace zones).
// Each row's distance is the split's OWN length, not cumulative — turned
// into "Xmi at M:SS/mi" segment lines for the same build_workout_playlist
// pipeline every other AI DJ mix uses (see ai_dj/workout.py's parse_workout),
// so a PacePro race plan gets pace-matched music exactly like a Runna
// workout, just without any warmup/cooldown/rest structure of its own.

export interface PaceProSplit {
  splitNum: number;
  distanceMi: number;
  paceSec: number; // seconds per mile
}

export type ParsePaceProResult =
  | { ok: true; splits: PaceProSplit[] }
  | { ok: false; error: string };

// "1.02 mi" / "1.02 mi" -> 1.02 (Garmin's export uses a non-breaking
// space before the unit; \s in JS regex already matches  ).
function parseMiles(text: string): number | null {
  const m = text.match(/([\d.]+)\s*mi/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return isNaN(n) ? null : n;
}

// "8:28 /mi" -> 508 (seconds per mile).
function parsePaceToSec(text: string): number | null {
  const m = text.match(/(\d+):(\d{2})/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// Splits a CSV line on commas that aren't inside quotes — PacePro's export
// has no quoted fields in practice, but this keeps the parser honest against
// a stray comma in a future export format rather than silently misaligning columns.
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if (c === "," && !inQuotes) {
      fields.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  fields.push(cur);
  return fields;
}

export function parsePaceProCsv(text: string): ParsePaceProResult {
  const lines = text.split(/\r\n|\r|\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return { ok: false, error: "The file is empty." };

  // First row is a header ("Splits,Split Distance,Split Pace") — detect it
  // by the first field not parsing as a split number, rather than assuming
  // row 0 is always the header (tolerates a header-less export too).
  const startIdx = isNaN(parseInt(splitCsvLine(lines[0])[0], 10)) ? 1 : 0;
  if (startIdx >= lines.length) return { ok: false, error: "No split rows found after the header." };

  const splits: PaceProSplit[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const fields = splitCsvLine(lines[i]).map(f => f.trim());
    if (fields.length < 3) {
      return { ok: false, error: `Row ${i + 1} doesn't have 3 columns: "${lines[i]}"` };
    }
    const splitNum = parseInt(fields[0], 10);
    const distanceMi = parseMiles(fields[1]);
    const paceSec = parsePaceToSec(fields[2]);
    if (isNaN(splitNum) || distanceMi == null || paceSec == null) {
      return { ok: false, error: `Row ${i + 1} couldn't be parsed: "${lines[i]}"` };
    }
    if (distanceMi <= 0) {
      return { ok: false, error: `Row ${i + 1} has a zero/negative distance: "${lines[i]}"` };
    }
    splits.push({ splitNum, distanceMi, paceSec });
  }

  if (splits.length === 0) return { ok: false, error: "No split rows found." };
  return { ok: true, splits };
}

export function fmtPaceSec(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Turns parsed splits into segment text lines for buildAiDjMix/parse_workout
// — each split becomes its own "Xmi at M:SS/mi" line, so the mixer treats
// every split as a distinct pace-matched "work" segment (see
// ai_dj/workout.py's _segment_kind: no warmup/cooldown/easy keyword here,
// so every split defaults to "work" - tight BPM tolerance, no upper limit,
// matching a real race-pace plan's all-effort nature).
export function paceProSplitsToSegments(splits: PaceProSplit[]): string[] {
  return splits.map(s => `${s.distanceMi}mi at ${fmtPaceSec(s.paceSec)}/mi`);
}

export function totalDistanceMi(splits: PaceProSplit[]): number {
  return splits.reduce((sum, s) => sum + s.distanceMi, 0);
}

export function totalDurationSec(splits: PaceProSplit[]): number {
  return splits.reduce((sum, s) => sum + s.distanceMi * s.paceSec, 0);
}

// Converts a Pace Pro import (3 columns: split #, distance, pace) into the
// 6-column shape the Runna schedule card's race-splits table uses
// (lib/race-splits.ts's RaceSplit — adds cumulative distance/pace),
// so a saved Pace Pro mix from the library can be "linked" onto a race
// workout without re-pasting or re-scanning its splits. Elevation change
// is always 0 here — Pace Pro's own export carries no elevation data at
// all, so this is a best-effort conversion, not a substitute for the real
// race-splits screenshot when elevation actually matters.
export function paceProSplitsToRaceSplits(splits: PaceProSplit[]): {
  splitNum: number; splitMi: number; splitPaceSec: number;
  cumulativeMi: number; cumulativePaceSec: number; elevationChangeM: number;
}[] {
  let cumMi = 0, cumSec = 0;
  return splits.map(s => {
    cumMi += s.distanceMi;
    cumSec += s.distanceMi * s.paceSec;
    return {
      splitNum: s.splitNum,
      splitMi: s.distanceMi,
      splitPaceSec: s.paceSec,
      cumulativeMi: Math.round(cumMi * 100) / 100,
      cumulativePaceSec: cumMi > 0 ? Math.round(cumSec / cumMi) : s.paceSec,
      elevationChangeM: 0,
    };
  });
}
