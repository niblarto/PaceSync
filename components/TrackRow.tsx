"use client";

import type { TrackWithBPM } from "@/types";

interface Props {
  track: TrackWithBPM;
  index: number;
  onDelete?: () => void;
}

function formatMs(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function openInSpotify(uri: string) {
  const trackId = uri.split(":")?.[2];
  if (!trackId) return;
  window.location.href = uri;
  const timer = setTimeout(() => {
    window.open(`https://open.spotify.com/track/${trackId}`, "_blank");
  }, 1000);
  const onVisibility = () => {
    if (document.hidden) {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
}

function TrashIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
      <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clipRule="evenodd" />
    </svg>
  );
}

export function TrackRow({ track, index, onDelete }: Props) {
  const artist = track.artists[0]?.name ?? "";
  const artSrc = `/api/itunes-art?artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(track.name)}`;

  return (
    <div className="flex items-center group">
      <button
        onClick={() => openInSpotify(track.uri)}
        className="flex-1 flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-slate-800/60 transition-colors text-left"
      >
        <span className="w-5 text-right text-xs text-slate-600 shrink-0">{index + 1}</span>

        <div className="h-9 w-9 rounded shrink-0 overflow-hidden bg-slate-800">
          <img
            src={artSrc}
            alt=""
            className="h-full w-full object-cover"
            onError={e => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate group-hover:text-green-400 transition-colors">{track.name}</p>
          <p className="text-xs text-slate-500 truncate">
            {track.artists.map((a) => a.name).join(", ")}
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

      {onDelete && (
        <button
          onClick={onDelete}
          className="opacity-0 group-hover:opacity-100 ml-1 mr-2 p-1.5 text-slate-600 hover:text-red-400 transition-all shrink-0 rounded"
          title="Remove from playlist and CSV"
        >
          <TrashIcon />
        </button>
      )}
    </div>
  );
}
