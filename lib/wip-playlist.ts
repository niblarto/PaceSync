import { call, forgetPlaylistSave, ownUserId, requestPlaylistSave, type SaveOutcome } from "@/lib/spotify-outbox";
import { getDb } from "@/lib/db";

// "_WIP" playlists: while a mix is open on the dashboard it is mirrored to a Spotify playlist named
// "<mix name>_WIP", which is what gets played through (Spotify moves on to the next track by itself).
// Every edit to the open mix is synced to it. Closing the mix or saving it to Spotify for real deletes
// (unfollows) the WIP playlist, and a nightly job sweeps up any that were left behind.
//
// Saves go through the outbox (lib/spotify-outbox.ts), so they are rate-limit safe: queued while
// Spotify is blocking, de-duplicated, and sent when the limit clears.

export const WIP_SUFFIX = "_WIP";
const KEY = "wip_playlist_ids";

const wipName = (mixName: string) => (mixName.endsWith(WIP_SUFFIX) ? mixName : `${mixName}${WIP_SUFFIX}`);

function readIds(): Record<string, string> {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(KEY) as { value_json: string } | undefined;
    if (row) return JSON.parse(row.value_json) as Record<string, string>;
  } catch { /* none yet */ }
  return {};
}
function writeIds(ids: Record<string, string>): void {
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(KEY, JSON.stringify(ids));
}

/** True for the "spotify:playlist:<id>" of a WIP playlist we created - the play route only accepts these as a context. */
export function isKnownWipContext(contextUri: string): boolean {
  const id = contextUri.split(":")[2];
  return !!id && Object.values(readIds()).includes(id);
}

export async function syncWipPlaylist(token: string, mixName: string, uris: string[], description: string): Promise<SaveOutcome> {
  const name = wipName(mixName);
  const out = await requestPlaylistSave(token, { name, description, uris });
  if (out.status === "saved") {
    const ids = readIds();
    if (ids[name] !== out.result.playlistId) { ids[name] = out.result.playlistId; writeIds(ids); }
  }
  return out;
}

async function unfollow(token: string, id: string): Promise<boolean> {
  const res = await call(token, `/playlists/${id}/followers`, { method: "DELETE" });
  return res.ok || res.status === 404;
}

/** Deletes the mix's WIP playlist (if it was ever created) and forgets it. Returns whether it is gone. */
export async function deleteWipPlaylist(token: string, mixName: string): Promise<boolean> {
  const name = wipName(mixName);
  const ids = readIds();
  const { id: stateId } = forgetPlaylistSave(name); // also drops a still-queued save
  const id = ids[name] ?? stateId;
  delete ids[name];
  writeIds(ids);
  if (!id) return true;
  return unfollow(token, id);
}

/** The nightly sweep: unfollows every playlist of yours whose name ends in "_WIP". */
export async function clearAllWipPlaylists(token: string): Promise<{ found: number; deleted: number; failed: string[] }> {
  const userId = await ownUserId(token);
  const found: { id: string; name: string }[] = [];
  let path: string | null = "/me/playlists?limit=50";
  while (path) {
    const res = await call(token, path);
    if (!res.ok) throw new Error(`List playlists ${res.status}`);
    const data = await res.json() as { items: { id: string; name: string; owner: { id: string } }[]; next: string | null };
    for (const p of data.items) if (p.owner.id === userId && p.name.endsWith(WIP_SUFFIX)) found.push({ id: p.id, name: p.name });
    path = data.next ? data.next.replace("https://api.spotify.com/v1", "") : null;
  }
  let deleted = 0;
  const failed: string[] = [];
  for (const p of found) {
    try {
      if (await unfollow(token, p.id)) { deleted++; forgetPlaylistSave(p.name); } else failed.push(p.name);
    } catch { failed.push(p.name); }
  }
  writeIds({});
  return { found: found.length, deleted, failed };
}
