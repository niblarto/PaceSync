// Song Crawler BPM field: "120-122" (range), "121,145,167" (those exact BPMs)
// or a mix ("120-122, 145"). A lone single number keeps the crawler's old
// ±1 tolerance; numbers inside a list are exact matches. Pure (no server
// imports) so the Settings page can validate while typing.

export interface BpmBand { lo: number; hi: number }

export type BpmSpecResult =
  | { ok: true; bands: BpmBand[]; label: string }
  | { ok: false; error: string };

const SINGLE_TOLERANCE = 1;
const DOUBLETIME_THRESHOLD = 95; // mirrors song-crawler / MixPaceChart
// Bands are returned in effective (running) tempo: a sub-95 BPM entry is read
// as half-time and counts at double, same as the tracks it's matched against.
const effective = (bpm: number) => (bpm < DOUBLETIME_THRESHOLD ? bpm * 2 : bpm);
const NUM = "(\\d+(?:\\.\\d+)?)";
const RANGE_RE = new RegExp(`^${NUM}\\s*[-–—]\\s*${NUM}$`);
const SINGLE_RE = new RegExp(`^${NUM}$`);

export function parseBpmSpec(spec: string | undefined | null): BpmSpecResult {
  const parts = (spec ?? "").split(/[,;]+/).map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return { ok: false, error: "enter a BPM, a range like 120-122, or a list like 121,145,167" };
  const bands: BpmBand[] = [];
  for (const part of parts) {
    const r = part.match(RANGE_RE);
    const s = part.match(SINGLE_RE);
    if (r) {
      const lo = parseFloat(r[1]);
      const hi = parseFloat(r[2]);
      if (!(lo > 0) || hi < lo) return { ok: false, error: `"${part}" isn't a valid range (low-high)` };
      bands.push({ lo: effective(lo), hi: effective(hi) });
    } else if (s) {
      const v = parseFloat(s[1]);
      if (!(v > 0)) return { ok: false, error: `"${part}" isn't a valid BPM` };
      bands.push({ lo: effective(v), hi: effective(v) });
    } else {
      return { ok: false, error: `"${part}" isn't a BPM or a range` };
    }
  }
  if (bands.length === 1 && bands[0].lo === bands[0].hi) {
    bands[0] = { lo: bands[0].lo - SINGLE_TOLERANCE, hi: bands[0].hi + SINGLE_TOLERANCE };
  }
  return { ok: true, bands, label: parts.join(", ") };
}
