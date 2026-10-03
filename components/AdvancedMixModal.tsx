"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

// Dashboard's Runna Schedule card -> "⚙️ Advanced AI DJ Mix" — lets the user
// override the normal track-picking criteria for ONE mix build: a BPM
// min/max range, a genre filter (same 3-tier main genre -> subgenre -> tag
// tree as the Dashboard's "Remix by genre…" picker, via the same
// /api/tracks/genres endpoint), an "ignore play count" toggle, and a
// "randomize" toggle for which of the matching tracks get sent to the
// mixer. None of this needs any change to the Python mixer's filtering
// logic — it's all computed here as a plain allowed-URI list, reusing the
// exact same `segmentCandidateUris` restriction mechanism Pace Pro already
// uses (ai_dj/workout.py's build_workout_playlist: restricts the library to
// these URIs first, falling back to the full library only if the restricted
// list can't fill the segment's time budget). "Ignore play count" is the
// one genuine new wire — lib/ai-dj-mix.ts's `ignorePlayCounts` param, which
// sends an empty playCounts object so the mixer's play-count tiering never
// activates at all (not just skipping the extra demotion weighting).

interface GenreHierarchyNode {
  mainGenre: string;
  subgenres: { subgenre: string; tags: { genre: string; count: number }[] }[];
}

export interface LibraryTrack {
  uri: string;
  name: string;
  artist: string;
  bpm: number; // Math.round(tempo), 0 = missing
}

// Max candidates the mixer's LLM step actually looks at (ai_dj/selector.py's
// MAX_CANDIDATES) — the randomize toggle only matters once the filtered
// list exceeds this, otherwise every match already fits and there's nothing
// to leave out.
const MAX_CANDIDATES = 150;

interface Props {
  workoutTitle: string;
  onClose: () => void;
  onBuild: (opts: { minBpm: number | null; maxBpm: number | null; genres: string[]; ignorePlayCounts: boolean; candidateUris: string[] }) => void;
}

// Minimal client-side CSV parser scoped to just what this modal needs for
// the BPM filter (uri/name/artist/bpm) — lib/csv-store.ts's parseCsv can't
// be imported here, it pulls in `fs/promises` at module scope which breaks
// a client bundle even though parseCsv itself never touches the
// filesystem. Genre resolution doesn't need this at all — it goes through
// /api/tracks/genre-uris server-side instead (same source the "Remix by
// genre…" picker uses), so this only needs to know BPM.
function parseLibraryCsv(text: string): LibraryTrack[] {
  const lines = text.replace(/\r/g, "").split("\n").filter(l => l.trim().length > 0);
  if (lines.length === 0) return [];
  const parseRow = (line: string): string[] => {
    const out: string[] = [];
    let cur = "", inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = !inQuotes;
      } else if (ch === "," && !inQuotes) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const headers = parseRow(lines[0]).map(h => h.trim().toLowerCase());
  const col = (...names: string[]) => headers.findIndex(h => names.some(n => h === n.toLowerCase()));
  const idxUri = col("track uri", "spotify uri", "uri", "id");
  const idxName = col("track name", "name");
  const idxArtist = col("artist name(s)", "artist");
  const idxBpm = col("bpm", "tempo");
  if (idxUri === -1 || idxName === -1) return [];

  const tracks: LibraryTrack[] = [];
  for (let i = 1; i < lines.length; i++) {
    const row = parseRow(lines[i]);
    const raw = row[idxUri]?.trim() ?? "";
    if (!raw) continue;
    const uri = raw.startsWith("spotify:") ? raw : `spotify:track:${raw}`;
    const bpm = idxBpm !== -1 ? parseFloat(row[idxBpm]) : NaN;
    tracks.push({
      uri,
      name: row[idxName]?.trim() || "Unknown",
      artist: idxArtist !== -1 ? (row[idxArtist]?.trim() || "Unknown") : "Unknown",
      bpm: !isNaN(bpm) && bpm > 0 ? Math.round(bpm) : 0,
    });
  }
  return tracks;
}

// Fisher-Yates — unbiased, unlike naive sort-by-Math.random().
function shuffle<T>(arr: T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function AdvancedMixModal({ workoutTitle, onClose, onBuild }: Props) {
  const [tracks, setTracks] = useState<LibraryTrack[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [minBpm, setMinBpm] = useState("");
  const [maxBpm, setMaxBpm] = useState("");
  const [ignorePlayCounts, setIgnorePlayCounts] = useState(false);
  const [randomize, setRandomize] = useState(false);

  // Genre tree — same hierarchy/endpoint as DashboardClient's "Remix by
  // genre…" picker.
  const [hierarchy, setHierarchy] = useState<GenreHierarchyNode[] | null>(null);
  const [genreFilterText, setGenreFilterText] = useState("");
  const [expandedBranches, setExpandedBranches] = useState<Set<string>>(new Set());
  const [selectedGenres, setSelectedGenres] = useState<Set<string>>(new Set());
  const [genreUris, setGenreUris] = useState<Set<string> | null>(null); // null = no genre filter active
  const [genreUrisLoading, setGenreUrisLoading] = useState(false);

  useEffect(() => {
    fetch("/api/playlist-csv")
      .then(r => { if (!r.ok) throw new Error("Failed to load library"); return r.text(); })
      .then(text => setTracks(parseLibraryCsv(text)))
      .catch(e => setLoadError(e instanceof Error ? e.message : "Failed to load library"));
    fetch("/api/tracks/genres")
      .then(r => r.json())
      .then((d: { hierarchy?: GenreHierarchyNode[] }) => setHierarchy(d.hierarchy ?? []))
      .catch(() => setHierarchy([]));
  }, []);

  // Resolve selected genre tags -> URIs server-side whenever the selection
  // changes — same lookup /api/tracks/genre-uris already serves the
  // Dashboard picker's own restricted-remix flow.
  useEffect(() => {
    if (selectedGenres.size === 0) { setGenreUris(null); return; }
    let cancelled = false;
    setGenreUrisLoading(true);
    fetch("/api/tracks/genre-uris", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ genres: Array.from(selectedGenres) }),
    })
      .then(r => r.json())
      .then((d: { uris?: string[] }) => { if (!cancelled) setGenreUris(new Set(d.uris ?? [])); })
      .catch(() => { if (!cancelled) setGenreUris(new Set()); })
      .finally(() => { if (!cancelled) setGenreUrisLoading(false); });
    return () => { cancelled = true; };
  }, [selectedGenres]);

  const q = genreFilterText.trim().toLowerCase();
  const filteredTree = useMemo(() => (hierarchy ?? [])
    .map(mg => ({
      mainGenre: mg.mainGenre,
      subgenres: mg.subgenres
        .map(sg => ({ subgenre: sg.subgenre, tags: sg.tags.filter(t => !q || t.genre.includes(q)) }))
        .filter(sg => sg.tags.length > 0),
    }))
    .filter(mg => mg.subgenres.length > 0), [hierarchy, q]);

  function toggleBranch(key: string) {
    setExpandedBranches(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function toggleGenre(g: string) {
    setSelectedGenres(prev => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g); else next.add(g);
      return next;
    });
  }

  function setGenres(genres: string[], on: boolean) {
    setSelectedGenres(prev => {
      const next = new Set(prev);
      for (const g of genres) { if (on) next.add(g); else next.delete(g); }
      return next;
    });
  }

  const filtered = useMemo(() => {
    if (!tracks) return [];
    const min = minBpm ? parseFloat(minBpm) : null;
    const max = maxBpm ? parseFloat(maxBpm) : null;
    return tracks.filter(t => {
      if (min != null && (t.bpm === 0 || t.bpm < min)) return false;
      if (max != null && (t.bpm === 0 || t.bpm > max)) return false;
      if (genreUris != null && !genreUris.has(t.uri)) return false;
      return true;
    });
  }, [tracks, minBpm, maxBpm, genreUris]);

  function handleBuild() {
    const uris = filtered.map(t => t.uri);
    const candidateUris = randomize && uris.length > MAX_CANDIDATES ? shuffle(uris).slice(0, MAX_CANDIDATES) : uris;
    onBuild({
      minBpm: minBpm ? parseFloat(minBpm) : null,
      maxBpm: maxBpm ? parseFloat(maxBpm) : null,
      genres: Array.from(selectedGenres),
      ignorePlayCounts,
      candidateUris,
    });
  }

  const busy = !tracks || genreUrisLoading;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        className="w-full max-w-2xl max-h-[85vh] rounded-2xl bg-slate-900 border border-white/10 overflow-hidden shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/10 shrink-0">
          <div className="min-w-0">
            <h3 className="font-semibold text-sm truncate">⚙️ Advanced AI DJ Mix</h3>
            <p className="text-xs text-slate-500 truncate">{workoutTitle}</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none shrink-0" title="Close (Esc)">×</button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar px-5 py-4 space-y-4">
          {loadError && <p className="text-sm text-red-400">{loadError}</p>}

          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">BPM range</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={minBpm}
                onChange={e => setMinBpm(e.target.value)}
                placeholder="Min"
                className="w-24 rounded-lg bg-slate-800 border border-slate-700 text-sm px-3 py-1.5 text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-purple-500"
              />
              <span className="text-slate-600 text-sm">–</span>
              <input
                type="number"
                value={maxBpm}
                onChange={e => setMaxBpm(e.target.value)}
                placeholder="Max"
                className="w-24 rounded-lg bg-slate-800 border border-slate-700 text-sm px-3 py-1.5 text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-purple-500"
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-medium text-slate-400">Genres</label>
              <span className="text-xs text-slate-500">
                {selectedGenres.size} selected
                {selectedGenres.size > 0 && (
                  <button onClick={() => setSelectedGenres(new Set())} className="ml-2 text-slate-500 hover:text-slate-300 underline">Clear</button>
                )}
              </span>
            </div>
            <input
              type="text"
              value={genreFilterText}
              onChange={e => setGenreFilterText(e.target.value)}
              placeholder="Filter genres…"
              className="w-full rounded-lg bg-slate-800 border border-slate-700 text-sm px-3 py-1.5 text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-purple-500 mb-2"
            />
            <div className="rounded-lg border border-white/10 divide-y divide-white/5 max-h-64 overflow-y-auto no-scrollbar">
              {hierarchy === null && <p className="text-sm text-slate-500 p-4 text-center">Loading genres…</p>}
              {hierarchy !== null && filteredTree.length === 0 && (
                <p className="text-sm text-slate-500 p-4 text-center">
                  {hierarchy.length === 0 ? "No genres tagged in the library yet." : "No genres match that filter."}
                </p>
              )}
              {filteredTree.map(mg => {
                const mgGenres = mg.subgenres.flatMap(sg => sg.tags.map(t => t.genre));
                const mgCount = mg.subgenres.reduce((sum, sg) => sum + sg.tags.reduce((s, t) => s + t.count, 0), 0);
                const mgSelectedCount = mgGenres.filter(g => selectedGenres.has(g)).length;
                const mgOpen = !!q || expandedBranches.has(mg.mainGenre);
                return (
                  <div key={mg.mainGenre}>
                    <div className="px-3 py-1.5 flex items-center gap-2 hover:bg-white/5 transition-colors">
                      <button onClick={() => toggleBranch(mg.mainGenre)} className="text-slate-500 hover:text-slate-300 shrink-0 w-4 text-center" title={mgOpen ? "Collapse" : "Expand"}>
                        {mgOpen ? "▾" : "▸"}
                      </button>
                      <button onClick={() => toggleBranch(mg.mainGenre)} className="text-sm text-slate-100 font-medium flex-1 min-w-0 text-left truncate">
                        {mg.mainGenre}
                        {mgSelectedCount > 0 && <span className="text-purple-400 font-normal"> · {mgSelectedCount} selected</span>}
                      </button>
                      <span className="text-xs text-slate-600 shrink-0">{mgCount}</span>
                      <button
                        onClick={() => setGenres(mgGenres, mgSelectedCount < mgGenres.length)}
                        className="text-xs text-purple-300/80 hover:text-purple-200 underline shrink-0"
                      >
                        {mgSelectedCount === mgGenres.length ? "none" : "all"}
                      </button>
                    </div>
                    {mgOpen && mg.subgenres.map(sg => {
                      const sgKey = `${mg.mainGenre}::${sg.subgenre}`;
                      const sgGenres = sg.tags.map(t => t.genre);
                      const sgCount = sg.tags.reduce((s, t) => s + t.count, 0);
                      const sgSelectedCount = sgGenres.filter(g => selectedGenres.has(g)).length;
                      const sgOpen = !!q || expandedBranches.has(sgKey);
                      return (
                        <div key={sgKey} className="pl-5 border-l border-white/5 ml-3.5">
                          <div className="px-3 py-1 flex items-center gap-2 hover:bg-white/5 transition-colors">
                            <button onClick={() => toggleBranch(sgKey)} className="text-slate-600 hover:text-slate-400 shrink-0 w-4 text-center text-xs" title={sgOpen ? "Collapse" : "Expand"}>
                              {sgOpen ? "▾" : "▸"}
                            </button>
                            <button onClick={() => toggleBranch(sgKey)} className="text-xs text-slate-300 flex-1 min-w-0 text-left truncate">
                              {sg.subgenre}
                              {sgSelectedCount > 0 && <span className="text-purple-400"> · {sgSelectedCount}</span>}
                            </button>
                            <span className="text-[11px] text-slate-700 shrink-0">{sgCount}</span>
                            <button
                              onClick={() => setGenres(sgGenres, sgSelectedCount < sgGenres.length)}
                              className="text-[11px] text-purple-300/70 hover:text-purple-200 underline shrink-0"
                            >
                              {sgSelectedCount === sgGenres.length ? "none" : "all"}
                            </button>
                          </div>
                          {sgOpen && sg.tags.map(({ genre, count }) => (
                            <label key={genre} className="pl-7 pr-3 py-1 flex items-center gap-2.5 hover:bg-white/5 transition-colors cursor-pointer">
                              <input
                                type="checkbox"
                                checked={selectedGenres.has(genre)}
                                onChange={() => toggleGenre(genre)}
                                className="accent-purple-500 shrink-0"
                              />
                              <span className="text-sm text-slate-200 flex-1 min-w-0 truncate">{genre}</span>
                              <span className="text-xs text-slate-600 shrink-0">{count}</span>
                            </label>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={ignorePlayCounts}
                onChange={e => setIgnorePlayCounts(e.target.checked)}
                className="accent-purple-500"
              />
              Ignore play count (don&apos;t deprioritize already-played tracks)
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={randomize}
                onChange={e => setRandomize(e.target.checked)}
                className="accent-purple-500"
              />
              Randomize candidates {filtered.length > MAX_CANDIDATES && (
                <span className="text-slate-500">(picks {MAX_CANDIDATES} at random from {filtered.length} matches)</span>
              )}
            </label>
          </div>

          <p className="text-xs text-slate-500 border-t border-white/5 pt-3">
            {busy ? "Loading…" : (
              <>
                {filtered.length} track{filtered.length === 1 ? "" : "s"} match{filtered.length === 1 ? "es" : ""} this filter
                {filtered.length > MAX_CANDIDATES && !randomize && ` (closest ${MAX_CANDIDATES} will be sent to the mixer)`}.
              </>
            )}
          </p>
        </div>

        <div className="px-5 py-3 border-t border-white/10 flex items-center justify-end gap-2 shrink-0">
          <button onClick={onClose} className="text-xs text-slate-500 hover:text-slate-300 px-3 py-1.5">Cancel</button>
          <button
            onClick={handleBuild}
            disabled={busy || filtered.length === 0}
            className="rounded-lg bg-purple-500 hover:bg-purple-400 disabled:opacity-40 text-black font-semibold text-xs px-4 py-1.5 transition-colors"
          >
            Build mix
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
