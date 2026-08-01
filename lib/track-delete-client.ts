import { freshSpotifyToken } from "@/lib/spotify-browser";

// Shared client-side delete flow: removes a track from the live Spotify
// "Running" playlist (best-effort — fire-and-forget, matching the original
// inline implementation in RunnaCard.tsx's deleteTrack) and then from the
// library CSV via the existing DELETE /api/tracks/delete route (which also
// records the deletion log and cascades to unpin any upcoming affected
// mixes). Callers own their own optimistic local UI state (e.g. a
// struck-through row) — this function only does the two network calls.
export function deleteTrackFromLibrary(uri: string, playlistId: string | null): void {
  if (playlistId) {
    freshSpotifyToken().then(token => {
      if (!token) return;
      return fetch(`https://api.spotify.com/v1/playlists/${playlistId}/items`, {
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
