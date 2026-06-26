"use client";

import { useState, useEffect, useRef } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";

const RUNNING_PLAYLIST_ID = process.env.NEXT_PUBLIC_RUNNING_PLAYLIST_ID ?? "";

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
}

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function BbcTrackRow({ track, index }: { track: Track; index: number }) {
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

  return (
    <button
      onClick={openInSpotify}
      disabled={!trackId}
      className="w-full flex items-center gap-3 px-3 py-2 text-sm hover:bg-slate-800/60 transition-colors text-left group disabled:cursor-default"
    >
      <span className="text-slate-600 text-xs w-5 shrink-0">{index + 1}</span>
      <div className="h-8 w-8 rounded shrink-0 overflow-hidden bg-slate-800">
        <img
          src={artSrc}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
          onError={e => { (e.target as HTMLImageElement).style.display = "none"; }}
        />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-slate-200 group-hover:text-green-400 transition-colors">{track.name}</p>
        <p className="truncate text-xs text-slate-500">{track.artistName}</p>
      </div>
      {trackId && <span className="text-slate-700 group-hover:text-green-500 text-xs shrink-0">↗</span>}
    </button>
  );
}

export function BbcPlaylistCard({ pid, defaultName, synopsis, onRemove, editHref }: Props) {
  const { data: session } = useSession();
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
    const token = session?.accessToken;
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
    const token = session?.accessToken;
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
      setUpdateMsg(
        `Added ${tracksWithUri.length} track${tracksWithUri.length !== 1 ? "s" : ""}` +
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
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-600 hover:bg-slate-500 disabled:opacity-40 text-slate-200 text-xs font-medium px-3 py-1.5 transition-colors whitespace-nowrap"
              >
                {updating ? <><Spinner />Updating…</> : "Update Running Playlist"}
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
        <div className="divide-y divide-white/10 max-h-64 overflow-y-auto rounded-lg border border-white/10 bg-slate-950/40">
          {tracks.map((t, i) => (
            <BbcTrackRow key={`${t.uri}-${i}`} track={t} index={i} />
          ))}
        </div>
      )}
    </div>
  );
}
