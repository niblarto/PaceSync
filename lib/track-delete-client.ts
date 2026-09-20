import { freshSpotifyToken, spotifyFetch } from "@/lib/spotify-browser";
import { getRunningPlaylist } from "@/components/useRunningPlaylist";

// Shared client-side delete flow: removes a track from the live Spotify
// "Running" playlist (best-effort — fire-and-forget, matching the original
// inline implementation in RunnaCard.tsx's deleteTrack) and then from the
// library CSV via the existing DELETE /api/tracks/delete route (which also
// records the deletion log and cascades to unpin any upcoming affected
// mixes). Callers own their own optimistic local UI state (e.g. a
// struck-through row) — this function only does the two network calls.
//
// Goes through spotifyFetch (the shared proxy-backed client), not a direct
// fetch() to api.spotify.com — a direct call bypasses the shared rate-limit
// sentinel entirely (never checks it before firing, never logs or records a
// 429 if it gets one), which is exactly the kind of invisible-to-every-log
// Spotify traffic that was found to still exist here after a prior
// investigation into an unexplained ~20hr rate-limit block.
// skipDeletedLog: for a duplicate-cleanup delete (Settings' "Possible
// duplicates" card) — removing a redundant copy of a song the library
// still legitimately has under its other URI isn't a "never bring this
// track back" decision, so it shouldn't blacklist the deleted URI the way
// every other delete path in this app deliberately does.
//
// playlistId is intentionally ignored in favor of getRunningPlaylist()'s own
// resolution — every caller sourced it from useRunningPlaylist()'s current
// render, which can still be the build-time fallback playlist id if that
// component hadn't finished its own /api/settings/playlist fetch yet.
// Confirmed as a real incident: a delete that raced ahead of that fetch
// removed a track from the OLD "Running" playlist (the fallback env id)
// instead of the actual active "Running-AI" playlist, while the local CSV/
// blacklist correctly recorded it against Running-AI — Spotify never
// actually lost the track, so it kept reappearing in later Exportify
// imports. The parameter stays (rather than removing it and updating every
// call site) so this fix applies everywhere at once.
export function deleteTrackFromLibrary(uri: string, playlistId: string | null, skipDeletedLog?: boolean): void {
  void playlistId; // superseded by getRunningPlaylist() below — see comment above
  getRunningPlaylist().then(({ id }) => {
    if (!id) return;
    return freshSpotifyToken().then(token => {
      if (!token) return;
      return spotifyFetch(`https://api.spotify.com/v1/playlists/${id}/items`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ uri }] }),
      });
    });
  }).catch(err => console.error("[delete] Spotify fetch error:", err));
  fetch("/api/tracks/delete", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spotifyUri: uri, skipDeletedLog }),
  }).catch(() => {});
}
