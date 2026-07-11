"use client";

import { useState, useEffect, useRef } from "react";
import { useSession } from "next-auth/react";
import { freshSpotifyToken } from "@/lib/spotify-browser";
import Link from "next/link";
import { FunnelIcon, SparklesIcon, MetronomeIcon, MiniSpinner, handleArtError } from "./TrackRow";
import { FloatingCard } from "./FloatingCard";
import { useRunningPlaylist } from "./useRunningPlaylist";

interface Track {
  uri: string;
  name: string;
  artistName: string;
}

interface Props {
  pid: string;
  defaultName: string;
  synopsis?: string;
  onRemove?: () => void;
  editHref?: string;
  onSimilar?: (track: Track) => void;
  onSuggest?: (track: Track, mode: "style" | "tempo") => void;
  suggestBusy?: { trackId: string; mode: "style" | "tempo" } | null;
  /** Card rendered inline directly below the row whose track id matches (suggestions popover) */
  inlineCard?: { trackId: string; node: React.ReactNode } | null;
}

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function BbcTrackRow({ track, index, onSimilar, onSuggest, suggestBusy }: {
  track: Track;
  index: number;
  onSimilar?: (track: Track) => void;
  onSuggest?: (track: Track, mode: "style" | "tempo") => void;
  suggestBusy?: "style" | "tempo" | null;
}) {
  const { data: session } = useSession();
  const trackId = track.uri?.split(":")?.[2];
  const artSrc = `/api/itunes-art?artist=${encodeURIComponent(track.artistName)}&title=${encodeURIComponent(track.name)}`;

  function openInSpotify() {
    if (!trackId) return;
    window.location.href = `spotify:track:${trackId}`;
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

  async function playTrack() {
    if (!trackId) return;
    const token = await freshSpotifyToken();
    if (token) {
      try {
        const res = await fetch("https://api.spotify.com/v1/me/player/play", {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ uris: [`spotify:track:${trackId}`] }),
        });
        if (res.ok) {
          // Bring the app forward on the track's page so its main panel
          // reflects what's now playing (the API only switches the audio).
          window.location.href = `spotify:track:${trackId}`;
          return;
        }
      } catch { /* fall through */ }
    }
    openInSpotify();
  }

  return (
    <div className="flex items-center group">
      <button
        onClick={() => { playTrack().catch(() => {}); }}
        disabled={!trackId}
        className="flex-1 flex items-center gap-3 px-3 py-2 text-sm hover:bg-slate-800/60 transition-colors text-left disabled:cursor-default min-w-0"
      >
        <span className="text-slate-600 text-xs w-5 shrink-0">{index + 1}</span>
        <div className="h-8 w-8 rounded shrink-0 overflow-hidden bg-slate-800">
          <img
            src={artSrc}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
            onError={e => handleArtError(e, track.uri || track.name)}
          />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-slate-200 group-hover:text-green-400 transition-colors">{track.name}</p>
          <p className="truncate text-xs text-slate-500">{track.artistName}</p>
        </div>
        {trackId && <span className="text-slate-700 group-hover:text-green-500 text-xs shrink-0">↗</span>}
      </button>

      {trackId && onSimilar && (
        <button
          onClick={() => onSimilar(track)}
          className="opacity-0 group-hover:opacity-100 ml-1 p-1.5 text-slate-600 hover:text-green-400 transition-all shrink-0 rounded"
          title="Filter playlist to songs like this"
        >
          <FunnelIcon />
        </button>
      )}
      {trackId && onSuggest && (
        <button
          onClick={() => onSuggest(track, "style")}
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
      {trackId && onSuggest && (
        <button
          onClick={() => onSuggest(track, "tempo")}
          disabled={!!suggestBusy}
          className={`mr-2 p-1.5 transition-all shrink-0 rounded ${
            suggestBusy === "tempo"
              ? "opacity-100 text-orange-400"
              : "opacity-0 group-hover:opacity-100 text-slate-600 hover:text-orange-400"
          }`}
          title="Search new songs like this (tempo)"
        >
          {suggestBusy === "tempo" ? <MiniSpinner /> : <MetronomeIcon />}
        </button>
      )}
    </div>
  );
}

export function BbcPlaylistCard({ pid, defaultName, synopsis, onRemove, editHref, onSimilar, onSuggest, suggestBusy, inlineCard }: Props) {
  const { data: session } = useSession();
  const { id: RUNNING_PLAYLIST_ID, name: runningPlaylistName } = useRunningPlaylist();
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressTotal, setProgressTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedUrl, setSavedUrl] = useState<string | null>(null);
  const [playlistName, setPlaylistName] = useState(defaultName);
  const [programName, setProgramName] = useState(defaultName);
  const [updating, setUpdating] = useState(false);
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);
  const [retryAfter, setRetryAfter] = useState<number | null>(null);
  const [episodePid, setEpisodePid] = useState<string>(pid);
  const [airDate, setAirDate] = useState<string | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [suggestAnchor, setSuggestAnchor] = useState<HTMLElement | null>(null);

  // Fetch episode date on mount without requiring the user to press Load
  useEffect(() => {
    fetch(`/api/bbc/episode-info?pid=${pid}`)
      .then(r => r.json())
      .then((d: { episodePid?: string; airDate?: string | null }) => {
        if (d.episodePid) setEpisodePid(d.episodePid);
        if (d.airDate) setAirDate(d.airDate);
      })
      .catch(() => {});
  }, [pid]);

  useEffect(() => {
    if (retryAfter !== null && retryAfter > 0 && !countdownRef.current) {
      countdownRef.current = setInterval(() => {
        setRetryAfter(prev => {
          if (prev === null || prev <= 1) {
            clearInterval(countdownRef.current!);
            countdownRef.current = null;
            return null;
          }
          return prev - 1;
        });
      }, 1000);
    }
    if (retryAfter === null && countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
  }, [retryAfter]);

  async function addTracksBrowser(playlistId: string, uris: string[]): Promise<void> {
    const token = await freshSpotifyToken();
    if (!token) throw new Error("No access token");
    for (let i = 0; i < uris.length; i += 100) {
      const res = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/items`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ uris: uris.slice(i, i + 100) }),
      });
      if (!res.ok) throw new Error(`Spotify ${res.status}: ${await res.text()}`);
    }
  }

  const loadTracks = async () => {
    const token = await freshSpotifyToken();
    if (!token) { setError("Not signed in"); return; }
    setLoading(true);
    setError(null);
    setSavedUrl(null);
    setRetryAfter(null);
    setProgress(0);
    setProgressTotal(0);

    try {
      const res = await fetch(`/api/bbc/tracks?pid=${pid}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.body) throw new Error("No response body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          if (!part.startsWith("data: ")) continue;
          await new Promise(r => setTimeout(r, 0));
          const msg = JSON.parse(part.slice(6)) as Record<string, unknown>;

          if (msg.type === "start") {
            setProgressTotal(msg.total as number);
            if (msg.programName) {
              setProgramName(msg.programName as string);
              setPlaylistName(msg.programName as string);
            }
            if (msg.episodePid) setEpisodePid(msg.episodePid as string);
            if (msg.airDate) setAirDate(msg.airDate as string);
          } else if (msg.type === "progress") {
            setProgress(msg.current as number);
          } else if (msg.type === "done") {
            setTracks((msg.tracks as Track[]) ?? []);
            setRetryAfter((msg.retryAfter as number | null) ?? null);
            if (msg.programName) {
              setProgramName(msg.programName as string);
              setPlaylistName(msg.programName as string);
            }
            if (msg.airDate) setAirDate(msg.airDate as string);
          } else if (msg.type === "error") {
            setError(msg.error as string);
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
      setProgress(0);
      setProgressTotal(0);
    }
  };

  const savePlaylist = async () => {
    const tracksWithUri = tracks.filter(t => t.uri);
    if (!tracksWithUri.length || !playlistName) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/spotify/create-playlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: playlistName,
          description: `${programName} via PaceSync`,
          trackUris: tracksWithUri.map(t => t.uri),
        }),
      });
      const data = await res.json() as { url?: string; tracksAdded?: boolean; trackUris?: string[]; error?: string };
      if (data.error) throw new Error(data.error);
      if (data.tracksAdded === false && data.url) {
        const playlistId = data.url.split("/").pop()!;
        try { await addTracksBrowser(playlistId, data.trackUris ?? tracksWithUri.map(t => t.uri)); } catch { /* show link anyway */ }
      }
      setSavedUrl(data.url ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const updateRunningPlaylist = async () => {
    if (!session?.accessToken || !tracks.length) return;
    setUpdating(true);
    setUpdateMsg(null);
    setError(null);
    try {
      const tracksWithUri = tracks.filter(t => t.uri);
      const noUri = tracks.length - tracksWithUri.length;
      if (tracksWithUri.length === 0) {
        setUpdateMsg(`No tracks could be matched — ${noUri} track${noUri !== 1 ? "s" : ""} not found`);
        return;
      }
      await addTracksBrowser(RUNNING_PLAYLIST_ID, tracksWithUri.map(t => t.uri));

      // Enrich with BPM/audio features via ReccoBeats, then add every track
      // to the local CSV pool regardless of whether enrichment found a match
      // — a track that Spotify accepted but ReccoBeats/Deezer couldn't match
      // (common for extended mixes, live versions, etc.) still needs a CSV
      // row so healActiveCsv() can keep retrying it later; skipping the row
      // entirely here left such tracks in Spotify but permanently invisible
      // to the local library.
      let enriched = 0;
      let added = 0;
      try {
        const er = await fetch("/api/bpm/enrich", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tracks: tracksWithUri.map(t => ({
              id: t.uri.split(":").pop()!,
              name: t.name,
              artist: t.artistName,
            })),
          }),
        });
        const ed = await er.json() as {
          features?: Record<string, { tempo: number; key: number; mode: number; energy: number; danceability: number; valence: number }>;
        };
        const rows = tracksWithUri.map(t => {
          const id = t.uri.split(":").pop()!;
          const f = ed.features?.[id];
          if (f) enriched++;
          return { uri: `spotify:track:${id}`, name: t.name, artist: t.artistName, ...f };
        });
        const ar = await fetch("/api/tracks/add", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tracks: rows }),
        });
        const ad = await ar.json() as { added?: number };
        added = ad.added ?? rows.length;
      } catch { /* enrichment is best-effort — playlist add already succeeded */ }

      const noBpm = added - enriched;
      setUpdateMsg(
        `Added ${tracksWithUri.length} track${tracksWithUri.length !== 1 ? "s" : ""}` +
        (enriched > 0 ? ` · ${enriched} with BPM data` : "") +
        (noBpm > 0 ? ` · ${noBpm} added without BPM data (will retry)` : "") +
        (noUri > 0 ? ` · ${noUri} not found on Spotify` : "")
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update");
    } finally {
      setUpdating(false);
    }
  };

  const pct = progressTotal > 0 ? Math.round((progress / progressTotal) * 100) : 0;

  return (
    <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="font-semibold flex items-center gap-2">
            <span className="text-xs font-bold rounded px-1.5 py-0.5 bg-[#FF4200] text-white">BBC</span>
            {defaultName}
          </h2>
          {synopsis && (
            <p className="text-xs text-slate-400 mt-0.5">{synopsis}</p>
          )}
          <p className="text-xs text-slate-500 mt-0.5 flex items-center gap-1.5">
            {airDate ?? "—"} ·{" "}
            <a
              href={`https://www.bbc.co.uk/programmes/${episodePid}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 hover:text-slate-300 underline underline-offset-2 transition-colors"
            >
              Programme info
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                <path fillRule="evenodd" d="M4.22 11.78a.75.75 0 0 1 0-1.06l5.5-5.5H6a.75.75 0 0 1 0-1.5h5.25a.75.75 0 0 1 .75.75V9.75a.75.75 0 0 1-1.5 0V6.28l-5.5 5.5a.75.75 0 0 1-1.06 0Z" clipRule="evenodd" />
              </svg>
            </a>
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {tracks.length > 0 && !savedUrl && (
            <>
              <input
                type="text"
                value={playlistName}
                onChange={e => setPlaylistName(e.target.value)}
                className="rounded-lg bg-slate-800 border border-slate-700 text-xs px-2.5 py-1.5 text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-green-500 w-44"
              />
              <button
                onClick={savePlaylist}
                disabled={saving}
                className="inline-flex items-center gap-1.5 rounded-lg bg-green-500 hover:bg-green-400 disabled:opacity-40 text-black font-semibold text-xs px-3 py-1.5 transition-colors whitespace-nowrap"
              >
                {saving ? <><Spinner />Saving…</> : "Save to Spotify"}
              </button>
              <button
                onClick={updateRunningPlaylist}
                disabled={updating}
                title={`Add these tracks to your active playlist, "${runningPlaylistName}"`}
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-600 hover:bg-slate-500 disabled:opacity-40 text-slate-200 text-xs font-medium px-3 py-1.5 transition-colors whitespace-nowrap"
              >
                {updating ? <><Spinner />Updating…</> : `Update "${runningPlaylistName}"`}
              </button>
            </>
          )}
          {savedUrl && (
            <a href={savedUrl} target="_blank" rel="noopener noreferrer"
              className="text-xs text-green-400 hover:text-green-300 underline">
              Open in Spotify ↗
            </a>
          )}
          <button
            onClick={loadTracks}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-slate-200 text-xs font-medium px-3 py-1.5 transition-colors"
          >
            {loading ? <><Spinner />Loading…</> : tracks.length > 0 ? "Refresh" : "Load"}
          </button>
          {editHref && (
            <Link
              href={editHref}
              className="p-1.5 text-slate-600 hover:text-slate-300 transition-colors rounded"
              title="Edit this BBC source"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                <path d="M2.695 14.763l-1.262 3.154a.5.5 0 00.65.65l3.155-1.262a4 4 0 001.343-.885L17.5 5.5a2.121 2.121 0 00-3-3L3.58 13.42a4 4 0 00-.885 1.343z" />
              </svg>
            </Link>
          )}
          {onRemove && (
            <button
              onClick={onRemove}
              className="p-1.5 text-slate-600 hover:text-red-400 transition-colors rounded"
              title="Remove this BBC source"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {loading && progressTotal > 0 && (
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-slate-500">
            <span>Matching tracks on Spotify…</span>
            <span>{progress}/{progressTotal} · {pct}%</span>
          </div>
          <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-green-500 rounded-full transition-all duration-200"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}
      {retryAfter !== null && (
        <p className="text-xs text-amber-400">
          Spotify rate limited — wait{" "}
          {retryAfter >= 3600
            ? `${Math.floor(retryAfter / 3600)}h ${Math.ceil((retryAfter % 3600) / 60)}min`
            : retryAfter >= 60
              ? `${Math.ceil(retryAfter / 60)}min`
              : `${retryAfter}s`}{" "}
          before refreshing
        </p>
      )}
      {updateMsg && <p className="text-xs text-green-400">{updateMsg}</p>}

      {tracks.length > 0 && (
        <div className="divide-y divide-white/10 max-h-64 overflow-y-auto no-scrollbar rounded-lg border border-white/10 bg-slate-950/40">
          {tracks.map((t, i) => (
            <div
              key={`${t.uri}-${i}`}
              ref={inlineCard && t.uri?.split(":")?.[2] === inlineCard.trackId
                ? (el) => { if (el) setSuggestAnchor(prev => (prev === el ? prev : el)); }
                : undefined}
            >
              <BbcTrackRow
                track={t}
                index={i}
                onSimilar={onSimilar}
                onSuggest={onSuggest}
                suggestBusy={suggestBusy && t.uri?.split(":")?.[2] === suggestBusy.trackId ? suggestBusy.mode : null}
              />
            </div>
          ))}
        </div>
      )}

      {/* Suggestions popover for a search seeded from one of this card's tracks —
          floats directly below the clicked row, over anything beneath */}
      {inlineCard && tracks.some(t => t.uri?.split(":")?.[2] === inlineCard.trackId) && (
        <FloatingCard anchor={suggestAnchor}>{inlineCard.node}</FloatingCard>
      )}
    </div>
  );
}
