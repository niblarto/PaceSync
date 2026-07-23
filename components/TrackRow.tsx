"use client";

import { useSession } from "next-auth/react";
import type { SyntheticEvent } from "react";
import type { TrackWithBPM } from "@/types";

interface Props {
  track: TrackWithBPM;
  index: number;
  onDelete?: () => void;
  onSimilar?: () => void;
  onSuggestStyle?: () => void;
  onSuggestTempo?: () => void;
  /** Which suggest search is currently running for THIS track (shows a spinner on that icon) */
  suggestBusy?: "style" | "tempo" | null;
  /** Confirmed "Today's Run" mixes this track has featured in, if any */
  playedCount?: number;
}

export function MiniSpinner() {
  return (
    <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function formatMs(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Start playback immediately on the user's active Spotify device (cuts off
// whatever is playing). Falls back to opening the app/web player when there's
// no active device, no premium, or the session lacks the playback scope.
export async function playInSpotify(uri: string, token?: string | null): Promise<void> {
  if (token) {
    try {
      const res = await fetch("https://api.spotify.com/v1/me/player/play", {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ uris: [uri] }),
      });
      if (res.ok) {
        // Playback switched, but the app's main panel keeps showing whatever
        // page was open (the API can't refresh it). Deep-link the track so
        // the app comes forward showing what's now playing.
        window.location.href = uri;
        return;
      }
    } catch { /* fall through to opening the app */ }
  }
  openInSpotify(uri);
}

// Navigate to a spotify: URI (opens the desktop/mobile app); if the page is
// still visible after a second the app didn't take over, so fall back to the
// web player.
export function openSpotifyAppFirst(uri: string, webUrl: string) {
  window.location.href = uri;
  const timer = setTimeout(() => {
    window.open(webUrl, "_blank");
  }, 1000);
  const onVisibility = () => {
    if (document.hidden) {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
}

export function openInSpotify(uri: string) {
  const trackId = uri.split(":")?.[2];
  if (!trackId) return;
  openSpotifyAppFirst(`spotify:track:${trackId}`, `https://open.spotify.com/track/${trackId}`);
}

// App-first open for any open.spotify.com URL (playlist, track, album, …).
export function openSpotifyUrl(webUrl: string) {
  const m = /open\.spotify\.com\/(playlist|track|album|artist|show|episode)\/([A-Za-z0-9]+)/.exec(webUrl);
  if (m) openSpotifyAppFirst(`spotify:${m[1]}:${m[2]}`, webUrl);
  else window.open(webUrl, "_blank");
}

export function FunnelIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
      <path fillRule="evenodd" d="M2.628 1.601C5.028 1.206 7.49 1 10 1s4.973.206 7.372.601a.75.75 0 01.628.74v2.288a2.25 2.25 0 01-.659 1.59l-4.682 4.683a2.25 2.25 0 00-.659 1.59v3.037c0 .684-.31 1.33-.844 1.757l-1.937 1.55A.75.75 0 018 18.25v-5.757a2.25 2.25 0 00-.659-1.591L2.659 6.22A2.25 2.25 0 012 4.629V2.34a.75.75 0 01.628-.74z" clipRule="evenodd" />
    </svg>
  );
}

export function SparklesIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
      <path fillRule="evenodd" d="M9 4.5a.75.75 0 01.721.544l.813 2.846a3.75 3.75 0 002.576 2.576l2.846.813a.75.75 0 010 1.442l-2.846.813a3.75 3.75 0 00-2.576 2.576l-.813 2.846a.75.75 0 01-1.442 0l-.813-2.846a3.75 3.75 0 00-2.576-2.576l-2.846-.813a.75.75 0 010-1.442l2.846-.813A3.75 3.75 0 007.466 7.89l.813-2.846A.75.75 0 019 4.5zM18 1.5a.75.75 0 01.728.568l.258 1.036c.236.94.97 1.674 1.91 1.91l1.036.258a.75.75 0 010 1.456l-1.036.258c-.94.236-1.674.97-1.91 1.91l-.258 1.036a.75.75 0 01-1.456 0l-.258-1.036a2.625 2.625 0 00-1.91-1.91l-1.036-.258a.75.75 0 010-1.456l1.036-.258a2.625 2.625 0 001.91-1.91l.258-1.036A.75.75 0 0118 1.5z" clipRule="evenodd" />
    </svg>
  );
}

export function MetronomeIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
      <path fillRule="evenodd" d="M10 2a.75.75 0 01.75.75v.258a33.186 33.186 0 016.668.83.75.75 0 01-.336 1.461 31.28 31.28 0 00-1.103-.232l1.702 7.545a.75.75 0 01-.387.832A4.981 4.981 0 0115 14c-.825 0-1.606-.2-2.294-.556a.75.75 0 01-.387-.832l1.77-7.849a31.743 31.743 0 00-3.339-.254v11.505a20.01 20.01 0 013.78.501.75.75 0 11-.339 1.462A18.558 18.558 0 0010 17.5c-1.442 0-2.845.165-4.191.477a.75.75 0 01-.338-1.462 20.01 20.01 0 013.779-.501V4.509c-1.129.026-2.243.112-3.34.254l1.771 7.85a.75.75 0 01-.387.83A4.98 4.98 0 015 14a4.98 4.98 0 01-2.294-.556.75.75 0 01-.387-.832L4.02 5.067c-.37.07-.738.148-1.103.232a.75.75 0 01-.336-1.462 33.184 33.184 0 016.668-.829V2.75A.75.75 0 0110 2z" clipRule="evenodd" />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
      <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clipRule="evenodd" />
    </svg>
  );
}

// Tracks with no album art fall back to one of four CD placeholder images in
// /public/cd-art. Picked by a stable hash of the track's id/name so the choice
// looks random across a listing but each track keeps the same cover between
// renders. If the placeholder is also missing, the image hides as before.
export function handleArtError(e: SyntheticEvent<HTMLImageElement>, key: string) {
  const img = e.target as HTMLImageElement;
  if (!img.dataset.cdFallback) {
    img.dataset.cdFallback = "1";
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
    img.src = `/cd-art/cd-${(Math.abs(h) % 4) + 1}.jpg`;
  } else {
    img.style.display = "none";
  }
}

export function TrackRow({ track, index, onDelete, onSimilar, onSuggestStyle, onSuggestTempo, suggestBusy, playedCount }: Props) {
  const { data: session } = useSession();
  const artist = track.artists[0]?.name ?? "";
  const artSrc = `/api/itunes-art?artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(track.name)}`;

  return (
    <div className="flex items-center group">
      <button
        onClick={() => { playInSpotify(track.uri, session?.accessToken).catch(() => {}); }}
        className="flex-1 flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-slate-800/60 transition-colors text-left"
      >
        <span className="w-5 text-right text-xs text-slate-600 shrink-0">{index + 1}</span>

        <div className="h-9 w-9 rounded shrink-0 overflow-hidden bg-slate-800">
          <img
            src={artSrc}
            alt=""
            className="h-full w-full object-cover"
            onError={e => handleArtError(e, track.id || track.name)}
          />
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate group-hover:text-green-400 transition-colors">{track.name}</p>
          <p className="text-xs text-slate-500 truncate">
            {track.artists.map((a) => a.name).join(", ")}
            {!!playedCount && (
              <span className="text-purple-400/80" title={`Featured in ${playedCount} confirmed "Today's Run" mix${playedCount === 1 ? "" : "es"}`}>
                {" · "}{playedCount} play{playedCount === 1 ? "" : "s"}
              </span>
            )}
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <span className="text-xs font-mono font-semibold text-green-400 bg-green-500/10 rounded px-1.5 py-0.5">
            {track.bpm} BPM
          </span>
          <span className="text-xs text-slate-600 w-10 text-right tabular-nums">
            {formatMs(track.duration_ms)}
          </span>
          <span className="text-slate-700 group-hover:text-green-500 text-xs shrink-0">↗</span>
        </div>
      </button>

      {onSimilar && (
        <button
          onClick={onSimilar}
          className="opacity-0 group-hover:opacity-100 ml-1 p-1.5 text-slate-600 hover:text-green-400 transition-all shrink-0 rounded"
          title="Filter playlist to songs like this"
        >
          <FunnelIcon />
        </button>
      )}
      {onSuggestStyle && (
        <button
          onClick={onSuggestStyle}
          disabled={!!suggestBusy}
          className={`p-1.5 transition-all shrink-0 rounded ${
            suggestBusy === "style"
              ? "opacity-100 text-purple-400"
              : "opacity-0 group-hover:opacity-100 text-slate-600 hover:text-purple-400"
          }`}
          title="Search new songs like this (style)"
        >
          {suggestBusy === "style" ? <MiniSpinner /> : <SparklesIcon />}
        </button>
      )}
      {onSuggestTempo && (
        <button
          onClick={onSuggestTempo}
          disabled={!!suggestBusy}
          className={`p-1.5 transition-all shrink-0 rounded ${
            suggestBusy === "tempo"
              ? "opacity-100 text-orange-400"
              : "opacity-0 group-hover:opacity-100 text-slate-600 hover:text-orange-400"
          }`}
          title="Search new songs like this (tempo)"
        >
          {suggestBusy === "tempo" ? <MiniSpinner /> : <MetronomeIcon />}
        </button>
      )}
      {onDelete && (
        <button
          onClick={onDelete}
          className="opacity-0 group-hover:opacity-100 mr-2 p-1.5 text-slate-600 hover:text-red-400 transition-all shrink-0 rounded"
          title="Remove from playlist and CSV"
        >
          <TrashIcon />
        </button>
      )}
    </div>
  );
}
