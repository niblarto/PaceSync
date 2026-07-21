"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { freshSpotifyToken } from "@/lib/spotify-browser";
import { useRunningPlaylist } from "./useRunningPlaylist";

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

export function DedupCard() {
  const { data: session } = useSession();
  const { id: RUNNING_PLAYLIST_ID } = useRunningPlaylist();
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // "Failed to fetch" is a bare network-level failure (no HTTP response at
  // all — dropped connection, brief offline blip), distinct from a Spotify
  // error status. A large library now means many sequential requests to
  // read the whole playlist, so one retry after a short pause absorbs a
  // transient blip instead of failing the whole run; `step` names what was
  // being done so a failure that survives the retry says exactly where.
  async function fetchWithRetry(url: string, init: RequestInit, step: string): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await fetch(url, init);
      } catch (e) {
        if (attempt === 1) {
          const detail = e instanceof Error ? e.message : String(e);
          throw new Error(`Network error while ${step}: ${detail}`);
        }
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    throw new Error(`Network error while ${step}`); // unreachable, satisfies TS
  }

  const run = async () => {
    const token = await freshSpotifyToken();
    if (!token) return;
    setRunning(true);
    setStatus("Reading Running playlist…");
    setError(null);

    try {
      // Read all items in playlist order
      const uris: string[] = [];
      let pageOffset = 0;
      let url: string | null =
        `https://api.spotify.com/v1/playlists/${RUNNING_PLAYLIST_ID}/items?limit=100`;

      while (url) {
        const res = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${token}` } }, `reading playlist page ${Math.floor(pageOffset / 100) + 1}`);
        if (!res.ok) throw new Error(`Spotify ${res.status}: ${await res.text()}`);
        const data = await res.json() as any;
        const items: unknown[] = data?.items ?? [];
        for (const item of items) {
          // New /items endpoint uses .track (same as old /tracks endpoint)
          const uri = (item as any)?.track?.uri ?? (item as any)?.item?.uri;
          if (typeof uri === "string" && uri.startsWith("spotify:track:")) {
            uris.push(uri);
          }
        }
        if (uris.length > 0 && uris.length % 300 === 0) {
          setStatus(`Reading… ${uris.length} tracks so far`);
        }
        pageOffset += items.length;
        url = (data?.next as string | null) ?? null;
      }

      setStatus(`Scanned ${uris.length} tracks — finding duplicates…`);

      // Build deduplicated list preserving oldest-first order
      const seen = new Set<string>();
      const deduped: string[] = [];
      for (const uri of uris) {
        if (!seen.has(uri)) {
          seen.add(uri);
          deduped.push(uri);
        }
      }

      const removedCount = uris.length - deduped.length;

      if (removedCount === 0) {
        setStatus(`No duplicates found in ${uris.length} tracks`);
        return;
      }

      // Newer Spotify accounts cannot use DELETE /tracks (deprecated, 403).
      // DELETE /items removes ALL occurrences of a URI with no position targeting.
      // Only reliable option: PUT to replace the playlist with the deduplicated list,
      // then POST additional chunks. PUT replaces with first 100; POST appends the rest.
      // Ref: https://developer.spotify.com/documentation/web-api/reference/replace-playlists-items

      setStatus(`Replacing playlist (${deduped.length} tracks, removing ${removedCount} duplicate${removedCount !== 1 ? "s" : ""})…`);

      const chunks: string[][] = [];
      for (let i = 0; i < deduped.length; i += 100) {
        chunks.push(deduped.slice(i, i + 100));
      }

      // PUT replaces entire playlist with first chunk
      const putRes = await fetchWithRetry(
        `https://api.spotify.com/v1/playlists/${RUNNING_PLAYLIST_ID}/items`,
        {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ uris: chunks[0] ?? [] }),
        },
        "replacing playlist with the deduplicated list"
      );
      if (!putRes.ok) throw new Error(`Spotify PUT ${putRes.status}: ${await putRes.text()}`);

      // POST each remaining chunk to append
      for (let i = 1; i < chunks.length; i++) {
        setStatus(`Writing… ${Math.min(i * 100, deduped.length)}/${deduped.length} tracks`);
        const postRes = await fetchWithRetry(
          `https://api.spotify.com/v1/playlists/${RUNNING_PLAYLIST_ID}/items`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ uris: chunks[i] }),
          },
          `writing batch ${i + 1}/${chunks.length}`
        );
        if (!postRes.ok) throw new Error(`Spotify POST ${postRes.status}: ${await postRes.text()}`);
      }

      setStatus(
        `Done — removed ${removedCount} duplicate${removedCount !== 1 ? "s" : ""} · ${deduped.length} tracks remain`
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 px-4 py-[29px]">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold text-slate-200 text-sm">Dedup Playlist</h2>
          <p className="text-xs text-slate-500 mt-0.5">Remove duplicates</p>
        </div>
        <button
          onClick={run}
          disabled={running}
          className="inline-flex items-center gap-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-slate-200 text-xs font-medium px-3 py-1.5 transition-colors whitespace-nowrap shrink-0"
        >
          {running ? <><Spinner />Running…</> : "Run Dedup"}
        </button>
      </div>
      {status && !error && (
        <p className="text-xs text-slate-400 mt-3">{status}</p>
      )}
      {error && <p className="text-xs text-red-400 mt-3">{error}</p>}
    </div>
  );
}
