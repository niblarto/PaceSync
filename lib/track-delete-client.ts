import { freshSpotifyToken, spotifyFetch } from "@/lib/spotify-browser";

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
export function deleteTrackFromLibrary(uri: string, playlistId: string | null): void {
  if (playlistId) {
    freshSpotifyToken().then(token => {
      if (!token) return;
      return spotifyFetch(`https://api.spotify.com/v1/playlists/${playlistId}/items`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ uri }] }),
      });
    }).catch(err => console.error("[delete] Spotify fetch error:", err));
  }
  fetch("/api/tracks/delete", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spotifyUri: uri }),
  }).catch(() => {});
}
