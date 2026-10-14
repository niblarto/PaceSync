import { getDb } from "@/lib/db";
import { readAllTracks } from "@/lib/tracks-store";
import { loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { getAllTodaysRunEntries } from "@/lib/todays-run-history";
import { getPaceProPin } from "@/lib/pace-pro-pin";
import { listSavedPaceProMixes } from "@/lib/pace-pro-saved";
import type { AiDjMixResponse } from "@/lib/ai-dj-mix";

// "Broken" tracklists: upcoming schedule mixes (pinned or saved, today
// onward) and Pace Pro mixes (the current pin + the saved library) that
// still reference a track no longer in the library. Deleting a track no
// longer unpins or wipes the mixes it's in — they stay as they are, the
// missing track is highlighted, and this scan drives the warning banner
// (/api/tracklists/broken) and the daily 08:00 check
// (/api/cron/broken-tracklists) until each one is repaired (Quick Swap).

export interface MissingTrack { uri: string; name: string; artist: string }

export interface BrokenTracklist {
  kind: "schedule" | "pacepro";
  key: string;          // stable id: "schedule:<date>:<title>" / "pacepro:<id>"
  title: string;
  date: string | null;  // workout date for schedule mixes
  missing: MissingTrack[];
  link: string;         // page that opens this tracklist
}

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function missingFrom(tracks: { uri?: string | null; name: string; artist: string }[], library: Set<string>): MissingTrack[] {
  const seen = new Set<string>();
  const out: MissingTrack[] = [];
  for (const t of tracks) {
    if (!t.uri || library.has(t.uri) || seen.has(t.uri)) continue;
    seen.add(t.uri);
    out.push({ uri: t.uri, name: t.name, artist: t.artist });
  }
  return out;
}

const timelineTracks = (timeline: AiDjMixResponse["timeline"]) => timeline.flatMap(s => s.tracks);

export function findBrokenTracklists(): BrokenTracklist[] {
  const library = new Set(readAllTracks(loadRunningPlaylistConfig().csvFile).map(t => t.uri).filter(Boolean));
  // An empty read (missing/locked CSV) would flag every mix — report nothing.
  if (library.size === 0) return [];
  const today = localToday();
  const out: BrokenTracklist[] = [];
  const scheduleKeys = new Set<string>();

  const pinned = getDb().prepare("SELECT date, workout_title, timeline_json FROM pinned_mixes WHERE date >= ?")
    .all(today) as { date: string; workout_title: string; timeline_json: string }[];
  for (const row of pinned) {
    const key = `schedule:${row.date}:${row.workout_title}`;
    scheduleKeys.add(key);
    let timeline: AiDjMixResponse["timeline"] = [];
    try { timeline = JSON.parse(row.timeline_json); } catch { continue; }
    const missing = missingFrom(timelineTracks(timeline), library);
    if (missing.length) out.push({ kind: "schedule", key, title: row.workout_title, date: row.date, missing, link: `/dashboard?openMix=${row.date}` });
  }

  // Saved (not pinned) schedule tracklists for upcoming workouts.
  for (const entry of getAllTodaysRunEntries()) {
    if (entry.date < today) continue;
    const key = `schedule:${entry.date}:${entry.workoutTitle}`;
    if (scheduleKeys.has(key)) continue;
    scheduleKeys.add(key);
    const missing = missingFrom(entry.tracks, library);
    if (missing.length) out.push({ kind: "schedule", key, title: entry.workoutTitle, date: entry.date, missing, link: `/dashboard?openMix=${entry.date}` });
  }

  // Pace Pro: saved library, plus the current pin when it isn't one of them.
  const saved = listSavedPaceProMixes();
  for (const mix of saved) {
    const missing = missingFrom(timelineTracks(mix.timeline), library);
    if (missing.length) out.push({ kind: "pacepro", key: `pacepro:${mix.id}`, title: mix.title, date: null, missing, link: `/pace-pro?openSaved=${encodeURIComponent(mix.id)}` });
  }
  const pin = getPaceProPin();
  if (pin && !saved.some(m => m.title.trim().toLowerCase() === pin.title.trim().toLowerCase())) {
    const missing = missingFrom(timelineTracks(pin.timeline), library);
    if (missing.length) out.push({ kind: "pacepro", key: "pacepro:pin", title: pin.title, date: null, missing, link: "/pace-pro" });
  }

  return out.sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999") || a.title.localeCompare(b.title));
}

// One line per broken tracklist, for the daily notification.
export function brokenTracklistsMessage(list: BrokenTracklist[]): string {
  return list.map(b => {
    const where = b.kind === "schedule" ? `${b.date} ${b.title}` : `Pace Pro: ${b.title}`;
    const names = b.missing.map(m => `${m.name} — ${m.artist}`).join("; ");
    return `• ${where} — ${b.missing.length} deleted: ${names}`;
  }).join("\n");
}
