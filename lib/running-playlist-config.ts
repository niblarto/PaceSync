import fs from "fs";
import path from "path";

// Which Spotify playlist is the app's "library" playlist — where BBC tracks
// get added, dedup runs, and deletes apply. Defaults to the Running playlist
// baked in via NEXT_PUBLIC_RUNNING_PLAYLIST_ID; the Settings page can point
// it at any other playlist by name (resolved to an id via the Spotify API).

const FILE = path.join(process.cwd(), "running-playlist.json");

export interface RunningPlaylistConfig {
  name: string;
  id: string;
}

export function loadRunningPlaylistConfig(): RunningPlaylistConfig {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf-8")) as RunningPlaylistConfig;
    if (data?.id && data?.name) return data;
  } catch { /* fall back to env */ }
  return { name: "Running", id: process.env.NEXT_PUBLIC_RUNNING_PLAYLIST_ID ?? "" };
}

export function saveRunningPlaylistConfig(config: RunningPlaylistConfig): void {
  fs.writeFileSync(FILE, JSON.stringify(config), "utf-8");
}
