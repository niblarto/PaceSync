import { readFile, writeFile } from "fs/promises";
import { activeCsvPath } from "@/lib/running-playlist-config";
import { csvEscape } from "@/lib/csv-merge";
import { findPreviouslyDeleted, removeFromDeletedLog, type DeletedTrack } from "@/lib/deleted-tracks";

// Single shared "add tracks to the library CSV" path — used by the
// /api/tracks/add route (BBC card, similar-song suggestions) and the weekly
// BBC cron, so previously-deleted-track rejection lives in exactly one place.

export interface LibraryAddTrack {
  uri: string;
  name: string;
  artist: string;
  tempo?: number;
  key?: number;
  mode?: number;
  energy?: number;
  danceability?: number;
  valence?: number;
}

export interface LibraryAddResult {
  added: number;
  // Previously-deleted tracks held back (not written). Callers surface these
  // for per-track override, or (cron) just log them.
  rejected: { uri: string; name: string; artist: string; deletedAt: string }[];
}

// allowDeletedUris: previously-deleted tracks explicitly overridden by the
// user — written anyway and removed from the deletion log.
export async function addTracksToLibrary(tracks: LibraryAddTrack[], allowDeletedUris?: string[]): Promise<LibraryAddResult> {
  const allowed = new Set(allowDeletedUris ?? []);
  const previouslyDeleted: Record<string, DeletedTrack> = findPreviouslyDeleted(tracks.map(t => t.uri));
  const rejected = Object.entries(previouslyDeleted)
    .filter(([uri]) => !allowed.has(uri))
    .map(([uri, d]) => ({ uri, name: d.name, artist: d.artist, deletedAt: d.deletedAt }));
  const rejectedUris = new Set(rejected.map(r => r.uri));

  const overridden = tracks.filter(t => previouslyDeleted[t.uri] && allowed.has(t.uri)).map(t => t.uri);
  if (overridden.length > 0) {
    try { removeFromDeletedLog(overridden); } catch (e) { console.warn("[library-add] deletion log update failed:", e); }
  }

  const csvPath = activeCsvPath();
  const csv = await readFile(csvPath, "utf8");
  const lines = csv.split("\n");
  const headers = lines[0].replace(/^﻿/, "").split(",").map(h => h.trim());

  const fresh = tracks.filter(t => t.uri && !rejectedUris.has(t.uri) && !csv.includes(t.uri));

  const newLines: string[] = [];
  for (const t of fresh) {
    const num = (v: number | undefined) => v == null ? "" : String(v);
    const byName: Record<string, string> = {
      "Track URI": t.uri,
      "Track Name": t.name,
      "Artist Name(s)": t.artist,
      "Tempo": num(t.tempo),
      "Key": num(t.key),
      "Mode": num(t.mode),
      "Energy": num(t.energy),
      "Danceability": num(t.danceability),
      "Valence": num(t.valence),
    };
    newLines.push(headers.map(h => csvEscape(byName[h] ?? "")).join(","));
  }

  if (newLines.length > 0) {
    const body = csv.endsWith("\n") ? csv : csv + "\n";
    await writeFile(csvPath, body + newLines.join("\n") + "\n", "utf8");
  }

  return { added: newLines.length, rejected };
}
