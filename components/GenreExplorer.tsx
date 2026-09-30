"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { playInSpotify } from "@/components/TrackRow";
import { deleteTrackFromLibrary } from "@/lib/track-delete-client";

// Settings -> Tracklist -> "Genre explorer" — same 3-tier main genre ->
// subgenre -> tag tree as the Dashboard's "Remix by genre" picker
// (lib/genre-hierarchy.ts, via /api/tracks/genres), but for LIBRARY
// MANAGEMENT rather than picking remix candidates: each leaf tag's own
// expanded track list lets a track be played (click the name), moved onto
// a different tag ("Move…"), or deleted from the library and active
// Spotify playlist ("🗑") — same actions the main Tracklist table offers,
// just reachable from inside the genre tree too, plus a tag-level "Move…"
// that reassigns EVERY track under that tag at once (e.g. folding a stray
// "other drum-and-bass" import artifact into the real "drum and bass" tag)
// via /api/tracks/move-genre. A standalone component (not sharing state
// with DashboardClient's own tree) since the two trees diverge enough
// (this one deletes/moves for library upkeep, that one selects remix
// candidates) that a shared generic component would need a large, awkward
// prop surface for what's ultimately two independent UIs that happen to
// look alike.

interface GenreHierarchyNode {
  mainGenre: string;
  subgenres: { subgenre: string; tags: { genre: string; count: number }[] }[];
}

interface GenreTagTrack {
  uri: string;
  name: string;
  artist: string;
  durationMs: number | null;
  tempo: number | null;
  energy: number | null;
}

// Identifies what's being moved: a whole tag ({tag}) or one specific track
// within it ({tag, uri}) — the same "Move to…" input/button UI serves both,
// keyed by this so a tag-level move and a track-level move never collide
// if somehow both were open (the UI itself only ever opens one at a time).
interface MoveTarget { tag: string; uri?: string; label: string }

export function GenreExplorer() {
  const { data: session } = useSession();
  const [open, setOpen] = useState(false);
  const [hierarchy, setHierarchy] = useState<GenreHierarchyNode[] | null>(null);
  const [filterText, setFilterText] = useState("");
  const [expandedBranches, setExpandedBranches] = useState<Set<string>>(new Set());
  // Which single genre leaf's own track list is expanded (accordion — at
  // most one at a time), and that genre's fetched tracks, cached per genre.
  const [expandedTag, setExpandedTag] = useState<string | null>(null);
  const [tagTracks, setTagTracks] = useState<Record<string, GenreTagTrack[] | "loading" | "error">>({});
  const [playingUri, setPlayingUri] = useState<string | null>(null);
  // Which target ("Move to…" picker) is open, and what's typed into it —
  // shared by both the tag-level and per-track move actions.
  const [moveTarget, setMoveTarget] = useState<MoveTarget | null>(null);
  const [moveTargetText, setMoveTargetText] = useState("");
  const [moveBusy, setMoveBusy] = useState(false);
  const [moveMsg, setMoveMsg] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);

// Unconditional fetch — always hits the server regardless of what
  // `hierarchy` currently holds, and deliberately does NOT null it out
  // first: the OLD tree stays on screen (and expandedBranches/expandedTag
  // stay meaningful against it) until the new data actually arrives, then
  // gets replaced in one atomic setHierarchy. An earlier version called
  // setHierarchy(null) before fetching — that not only raced load()'s own
  // stale-closure guard (fixed separately), it also unmounts the ENTIRE
  // tree for one render (filteredTree.map over [] while hierarchy is
  // null shows the "Loading genres…" placeholder instead), which is a
  // confusing flash even once the data comes back correctly, and was
  // reported live as the tree coming back looking wrong (a branch's
  // header showing with no children) after a move — nulling the tree out
  // and back in is exactly the kind of transient state a screenshot can
  // catch mid-flight. load() below is the guarded "only fetch if we don't
  // have one yet" wrapper around this for the initial open.
  function refreshHierarchy() {
    fetch("/api/tracks/genres")
      .then(r => r.json())
      .then((d: { hierarchy?: GenreHierarchyNode[] }) => setHierarchy(d.hierarchy ?? []))
      .catch(() => setHierarchy(prev => prev ?? []));
  }

  function load() {
    if (hierarchy !== null) return;
    refreshHierarchy();
  }

  function toggleOpen() {
    setOpen(o => {
      if (!o) load();
      return !o;
    });
  }

  function toggleBranch(key: string) {
    setExpandedBranches(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  // Every real genre tag currently in the tree, flattened — used as the
  // "Move to…" autocomplete list so a typo doesn't quietly create a brand
  // new, never-mapped tag instead of merging into an existing one.
  const allTags = (hierarchy ?? []).flatMap(mg => mg.subgenres.flatMap(sg => sg.tags.map(t => t.genre)));

  // "Show tracks" — toggles a single genre leaf's own track list open/
  // closed (accordion, at most one open at a time), fetching on first
  // expand via the same single-genre endpoint the Dashboard's "Remix by
  // genre" picker uses for its own track-expansion panel.
  function toggleTagTracks(genre: string) {
    if (expandedTag === genre) { setExpandedTag(null); return; }
    setExpandedTag(genre);
    if (tagTracks[genre] !== undefined) return;
    setTagTracks(prev => ({ ...prev, [genre]: "loading" }));
    fetch(`/api/tracks/genre-uris?genre=${encodeURIComponent(genre)}`)
      .then(r => r.json())
      .then((d: { tracks?: GenreTagTrack[]; error?: string }) => {
        setTagTracks(prev => ({ ...prev, [genre]: d.error || !d.tracks ? "error" : d.tracks }));
      })
      .catch(() => setTagTracks(prev => ({ ...prev, [genre]: "error" })));
  }

  function playTrack(uri: string) {
    setPlayingUri(uri);
    playInSpotify(uri, session?.accessToken).catch(() => {});
  }

  // Deletes from the library CSV and the active Spotify playlist (same
  // deleteTrackFromLibrary every other Settings delete uses). Its two
  // network calls are fire-and-forget (never awaited even here — see that
  // function's own comment), so this updates counts/tree state directly
  // from what's already known just got removed instead of ever re-fetching
  // from the server — a refetch right after an unawaited delete can land
  // before the write finishes and echo back the stale pre-delete count
  // (this exact race was already hit and fixed once, in DashboardClient's
  // own genre-track delete — same fix applied here).
  function deleteTrack(genre: string, t: GenreTagTrack) {
    deleteTrackFromLibrary(t.uri, null);
    setTagTracks(prev => {
      const list = prev[genre];
      if (!Array.isArray(list)) return prev;
      return { ...prev, [genre]: list.filter(x => x.uri !== t.uri) };
    });
    const tracks = tagTracks[genre];
    const emptied = Array.isArray(tracks) && tracks.length === 1 && tracks[0].uri === t.uri;
    setHierarchy(prev => prev && prev
      .map(mg => ({
        mainGenre: mg.mainGenre,
        subgenres: mg.subgenres
          .map(sg => ({
            subgenre: sg.subgenre,
            tags: sg.tags
              .map(tag => tag.genre === genre ? { ...tag, count: tag.count - 1 } : tag)
              .filter(tag => !(emptied && tag.genre === genre)),
          }))
          .filter(sg => sg.tags.length > 0),
      }))
      .filter(mg => mg.subgenres.length > 0));
    if (emptied && expandedTag === genre) setExpandedTag(null);
  }

  function startMove(tag: string, uri: string | undefined, label: string) {
    setMoveTarget({ tag, uri, label });
    setMoveTargetText("");
    setMoveError(null);
  }

  async function commitMove() {
    if (!moveTarget) return;
    const { tag: fromTag, uri } = moveTarget;
    const toTag = moveTargetText.trim().toLowerCase();
    if (!toTag) return;
    if (toTag === fromTag) { setMoveError("Pick a different genre to move into."); return; }
    setMoveBusy(true);
    setMoveError(null);
    try {
      const res = await fetch("/api/tracks/move-genre", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: fromTag, to: toTag, uri }),
      });
      const d = await res.json() as { ok?: boolean; moved?: number; error?: string };
      if (!res.ok || d.error) throw new Error(d.error ?? "Failed to move genre");
      setMoveMsg(
        uri
          ? `Moved "${moveTarget.label}" from "${fromTag}" to "${toTag}".`
          : `Moved ${d.moved} track${d.moved === 1 ? "" : "s"} from "${fromTag}" to "${toTag}".`
      );
      setMoveTarget(null);
      // Cached track lists (and the counts/tree itself) can't be patched
      // client-side as cheaply as the Dashboard picker's delete case (a
      // move can create a whole new leaf tag under `to` this tree has
      // never seen before, not just decrement an existing one) — a full
      // re-fetch is simplest and correct here.
      setTagTracks({});
      setExpandedTag(null);
      refreshHierarchy();
    } catch (e) {
      setMoveError(e instanceof Error ? e.message : "Failed to move genre");
    } finally {
      setMoveBusy(false);
    }
  }

  const q = filterText.trim().toLowerCase();
  const filteredTree = (hierarchy ?? [])
    .map(mg => ({
      mainGenre: mg.mainGenre,
      subgenres: mg.subgenres
        .map(sg => ({ subgenre: sg.subgenre, tags: sg.tags.filter(t => !q || t.genre.includes(q)) }))
        .filter(sg => sg.tags.length > 0),
    }))
    .filter(mg => mg.subgenres.length > 0);

  return (
    <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 overflow-hidden">
      <button
        onClick={toggleOpen}
        className="w-full flex items-center justify-between gap-4 p-5 text-left hover:bg-slate-800/40 transition-colors"
      >
        <h3 className="font-semibold text-slate-200">🧭 Genre explorer</h3>
        <span className={`text-slate-500 text-sm transition-transform ${open ? "rotate-180" : ""}`}>▾</span>
      </button>
      {open && (
        <div className="border-t border-white/10 p-5 space-y-3">
          <p className="text-xs text-slate-500">
            Browse the library&apos;s genre tags. Move a tag&apos;s tracks onto another existing tag to fix a
            miscategorized or duplicate genre (e.g. fold &quot;other drum-and-bass&quot; into &quot;drum and bass&quot;).
          </p>
          <input
            type="text"
            value={filterText}
            onChange={e => setFilterText(e.target.value)}
            placeholder="Filter genres…"
            className="w-full rounded-lg bg-slate-800/60 border border-white/10 text-sm px-3 py-1.5 text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-sky-500"
          />
          {moveMsg && (
            <p className="text-xs text-emerald-400">
              {moveMsg} <button onClick={() => setMoveMsg(null)} className="text-slate-500 hover:text-slate-300 underline">Dismiss</button>
            </p>
          )}

          <div className="rounded-lg border border-white/10 divide-y divide-white/5 max-h-[28rem] overflow-y-auto no-scrollbar">
            {hierarchy === null && (
              <p className="text-sm text-slate-500 p-4 text-center">Loading genres…</p>
            )}
            {hierarchy !== null && filteredTree.length === 0 && (
              <p className="text-sm text-slate-500 p-4 text-center">
                {hierarchy.length === 0 ? "No genres tagged in the library yet." : "No genres match that filter."}
              </p>
            )}
            {filteredTree.map(mg => {
              const mgOpen = !!q || expandedBranches.has(mg.mainGenre);
              const mgCount = mg.subgenres.reduce((sum, sg) => sum + sg.tags.reduce((s, t) => s + t.count, 0), 0);
              return (
                <div key={mg.mainGenre}>
                  <button
                    onClick={() => toggleBranch(mg.mainGenre)}
                    className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-white/5 transition-colors text-left"
                  >
                    <span className="text-slate-500 shrink-0 w-4 text-center">{mgOpen ? "▾" : "▸"}</span>
                    <span className="text-sm text-slate-100 font-medium flex-1 min-w-0 truncate">{mg.mainGenre}</span>
                    <span className="text-xs text-slate-600 shrink-0">{mgCount}</span>
                  </button>
                  {mgOpen && mg.subgenres.map(sg => {
                    const sgKey = `${mg.mainGenre}::${sg.subgenre}`;
                    const sgOpen = !!q || expandedBranches.has(sgKey);
                    const sgCount = sg.tags.reduce((s, t) => s + t.count, 0);
                    return (
                      <div key={sgKey} className="pl-5 border-l border-white/5 ml-3.5">
                        <button
                          onClick={() => toggleBranch(sgKey)}
                          className="w-full px-3 py-1 flex items-center gap-2 hover:bg-white/5 transition-colors text-left"
                        >
                          <span className="text-slate-600 shrink-0 w-4 text-center text-xs">{sgOpen ? "▾" : "▸"}</span>
                          <span className="text-xs text-slate-300 flex-1 min-w-0 truncate">{sg.subgenre}</span>
                          <span className="text-[11px] text-slate-700 shrink-0">{sgCount}</span>
                        </button>
                        {sgOpen && sg.tags.map(({ genre, count }) => {
                          const tagOpen = expandedTag === genre;
                          const tracks = tagTracks[genre];
                          return (
                            <div key={genre}>
                              <div className="pl-7 pr-3 py-1 flex items-center gap-2.5 hover:bg-white/5 transition-colors">
                                <button onClick={() => toggleTagTracks(genre)} className="text-sm text-slate-200 flex-1 min-w-0 text-left truncate hover:text-white">
                                  {genre}
                                </button>
                                <span className="text-xs text-slate-600 shrink-0">{count}</span>
                                <button
                                  onClick={() => startMove(genre, undefined, genre)}
                                  className="text-xs text-sky-300/80 hover:text-sky-200 underline shrink-0"
                                >
                                  Move…
                                </button>
                                <button
                                  onClick={() => toggleTagTracks(genre)}
                                  title={tagOpen ? "Hide tracks" : "Show tracks"}
                                  className="text-slate-500 hover:text-slate-300 shrink-0 w-4 text-center text-xs"
                                >
                                  {tagOpen ? "▾" : "▸"}
                                </button>
                              </div>
                              {moveTarget?.tag === genre && !moveTarget.uri && (
                                <div className="pl-7 pr-3 pb-2 flex items-center gap-2">
                                  <input
                                    type="text"
                                    list="genre-explorer-move-targets"
                                    value={moveTargetText}
                                    onChange={e => setMoveTargetText(e.target.value)}
                                    onKeyDown={e => { if (e.key === "Enter") void commitMove(); if (e.key === "Escape") setMoveTarget(null); }}
                                    placeholder="Move all its tracks to…"
                                    autoFocus
                                    className="flex-1 min-w-0 rounded-lg bg-slate-800/60 border border-white/10 text-xs px-2.5 py-1 text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-sky-500"
                                  />
                                  <button
                                    onClick={() => void commitMove()}
                                    disabled={moveBusy || !moveTargetText.trim()}
                                    className="text-xs rounded-lg bg-sky-500/15 border border-sky-500/40 hover:bg-sky-500/25 disabled:opacity-40 text-sky-300 px-2.5 py-1 transition-colors shrink-0"
                                  >
                                    {moveBusy ? "Moving…" : "Move"}
                                  </button>
                                  <button onClick={() => setMoveTarget(null)} className="text-xs text-slate-500 hover:text-slate-300 shrink-0">✕</button>
                                </div>
                              )}
                              {moveTarget?.tag === genre && !moveTarget.uri && moveError && (
                                <p className="pl-7 pr-3 pb-2 text-xs text-red-400">{moveError}</p>
                              )}
                              {tagOpen && (
                                <div className="pl-12 pr-3 pb-1.5 space-y-0.5">
                                  {tracks === "loading" && <p className="text-xs text-slate-500 py-1">Loading tracks…</p>}
                                  {tracks === "error" && <p className="text-xs text-red-400 py-1">Failed to load tracks.</p>}
                                  {Array.isArray(tracks) && tracks.length === 0 && <p className="text-xs text-slate-600 py-1">No tracks.</p>}
                                  {Array.isArray(tracks) && tracks.map(t => (
                                    <div key={t.uri}>
                                      <div className="flex items-center gap-2 py-0.5">
                                        <button
                                          onClick={() => playTrack(t.uri)}
                                          title="Play in Spotify"
                                          className={`text-xs flex-1 min-w-0 text-left truncate ${playingUri === t.uri ? "text-orange-400" : "text-slate-300 hover:text-white"}`}
                                        >
                                          {t.name} <span className="text-slate-600">— {t.artist}</span>
                                        </button>
                                        {t.tempo != null && <span className="text-[11px] text-slate-600 shrink-0">{Math.round(t.tempo)} BPM</span>}
                                        <button
                                          onClick={() => startMove(genre, t.uri, t.name)}
                                          className="text-[11px] text-sky-300/80 hover:text-sky-200 underline shrink-0"
                                        >
                                          Move…
                                        </button>
                                        <button
                                          onClick={() => deleteTrack(genre, t)}
                                          title="Delete this track from the library and active Spotify playlist"
                                          className="text-slate-600 hover:text-red-400 shrink-0 text-xs px-1"
                                        >
                                          🗑
                                        </button>
                                      </div>
                                      {moveTarget?.tag === genre && moveTarget.uri === t.uri && (
                                        <div className="pl-3 pb-1.5 flex items-center gap-2">
                                          <input
                                            type="text"
                                            list="genre-explorer-move-targets"
                                            value={moveTargetText}
                                            onChange={e => setMoveTargetText(e.target.value)}
                                            onKeyDown={e => { if (e.key === "Enter") void commitMove(); if (e.key === "Escape") setMoveTarget(null); }}
                                            placeholder={`Move "${t.name}" to…`}
                                            autoFocus
                                            className="flex-1 min-w-0 rounded-lg bg-slate-800/60 border border-white/10 text-xs px-2.5 py-1 text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-sky-500"
                                          />
                                          <button
                                            onClick={() => void commitMove()}
                                            disabled={moveBusy || !moveTargetText.trim()}
                                            className="text-xs rounded-lg bg-sky-500/15 border border-sky-500/40 hover:bg-sky-500/25 disabled:opacity-40 text-sky-300 px-2.5 py-1 transition-colors shrink-0"
                                          >
                                            {moveBusy ? "Moving…" : "Move"}
                                          </button>
                                          <button onClick={() => setMoveTarget(null)} className="text-xs text-slate-500 hover:text-slate-300 shrink-0">✕</button>
                                        </div>
                                      )}
                                      {moveTarget?.tag === genre && moveTarget.uri === t.uri && moveError && (
                                        <p className="pl-3 pb-1.5 text-xs text-red-400">{moveError}</p>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
          <datalist id="genre-explorer-move-targets">
            {allTags.map(g => <option key={g} value={g} />)}
          </datalist>
        </div>
      )}
    </div>
  );
}
