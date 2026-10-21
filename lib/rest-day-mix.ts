import { readAllTracks } from "@/lib/tracks-store";
import { loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { getPlayCounts } from "@/lib/play-counts";
import type { AiDjMixResponse, AiDjMixResult } from "@/lib/ai-dj-mix";
import { REST_MIX_SEC, REST_MIX_SEGMENT } from "@/lib/rest-day-mix-shared";

// Rest-day mix — two hours of songs never played in a confirmed run, any
// BPM, picked by when they were added to the library (no AI DJ):
//   - songs are grouped by the day they were added, oldest day first;
//   - one song is taken from each day in turn, oldest to newest;
//   - if two hours isn't reached after the newest day, go back to the
//     oldest day and take each day's next song, and so on until it is
//     (or every unplayed song has been used).
// avoidUris (a remix) are skipped where possible so a remix differs, but
// still used if the mix would otherwise come up short.

type Row = { uri: string; name: string; artist: string; addedAt: string; durationSec: number; tempo: number; energy: number };

function pickRoundRobin(rows: Row[], budgetSec: number, already: number): { picked: Row[]; total: number } {
  const byDay = new Map<string, Row[]>();
  for (const r of rows) {
    const day = r.addedAt.slice(0, 10) || "0000-00-00"; // unknown add date counts as oldest
    const list = byDay.get(day);
    if (list) list.push(r); else byDay.set(day, [r]);
  }
  const days = Array.from(byDay.keys()).sort();
  for (const d of days) byDay.get(d)!.sort((a, b) => a.addedAt.localeCompare(b.addedAt));

  const picked: Row[] = [];
  let total = already;
  for (let round = 0; total < budgetSec; round++) {
    let tookAny = false;
    for (const d of days) {
      const list = byDay.get(d)!;
      if (round >= list.length) continue;
      picked.push(list[round]);
      total += list[round].durationSec;
      tookAny = true;
      if (total >= budgetSec) break;
    }
    if (!tookAny) break; // every song used
  }
  return { picked, total };
}

export function buildRestDayMix(avoidUris?: string[], extraPlayCounts?: Record<string, number>): AiDjMixResult {
  const library = readAllTracks(loadRunningPlaylistConfig().csvFile);
  const played = getPlayCounts();
  const demoted = new Set(Object.keys(extraPlayCounts ?? {}));
  const seen = new Set<string>();
  const unplayed: Row[] = [];
  for (const t of library) {
    if (!t.uri || seen.has(t.uri)) continue;
    seen.add(t.uri);
    if ((played[t.uri] ?? 0) > 0 || demoted.has(t.uri)) continue;
    if (!t.durationMs || t.durationMs <= 0) continue; // can't be timed
    unplayed.push({
      uri: t.uri,
      name: t.trackName ?? "",
      artist: t.artistNames ?? "",
      addedAt: t.addedAt ?? "",
      durationSec: Math.round(t.durationMs / 1000),
      tempo: t.tempo ?? 0,
      energy: t.energy ?? 0,
    });
  }
  if (unplayed.length === 0) return { ok: false, error: "No unplayed songs with a known length in the library" };

  // Prefer songs not in the previous build (remix); top up from them if short.
  const avoid = new Set(avoidUris ?? []);
  const fresh = unplayed.filter(r => !avoid.has(r.uri));
  let { picked, total } = pickRoundRobin(fresh, REST_MIX_SEC, 0);
  if (total < REST_MIX_SEC) {
    const more = pickRoundRobin(unplayed.filter(r => avoid.has(r.uri)), REST_MIX_SEC, total);
    picked = picked.concat(more.picked);
    total = more.total;
  }

  let cursor = 0;
  const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  const tracks: AiDjMixResponse["timeline"][number]["tracks"] = picked.map(r => {
    const startsAt = mmss(cursor);
    cursor += r.durationSec;
    return { uri: r.uri, name: r.name, artist: r.artist, startsAt, durationSec: r.durationSec, tempo: r.tempo, camelot: null, energy: r.energy };
  });
  return {
    ok: true,
    mix: {
      trackUris: picked.map(r => r.uri),
      totalSec: total,
      timeline: [{ segment: REST_MIX_SEGMENT, targetBpm: null, targetPaceSec: null, tracks }],
    },
  };
}
