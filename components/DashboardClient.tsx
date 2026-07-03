"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { FloatingCard } from "./FloatingCard";
import { signOut, useSession } from "next-auth/react";
import Link from "next/link";
import type { RunningZone, TrackWithBPM } from "@/types";
import { ZoneCard } from "./ZoneCard";
import { TrackRow, playInSpotify } from "./TrackRow";
import { BbcPlaylistCard } from "./BbcPlaylistCard";
import { DedupCard } from "./DedupCard";
import { RunnaSummaryCard, RunnaScheduleCard } from "./RunnaCard";
import { filterTracksByBPM, getDefaultZones } from "@/lib/bpm-zones";

function prewarmArt(tracks: TrackWithBPM[]) {
  const payload = tracks.map(t => ({ artist: t.artists[0]?.name ?? "", title: t.name }));
  fetch("/api/itunes-art", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tracks: payload }),
  }).catch(() => {});
}

const ALL_ZONE: RunningZone = {
  number: 0,
  name: "All Songs",
  description: "All tempo ranges",
  hrMin: 0,
  hrMax: -1,
  bpmMin: 0,
  bpmMax: 9999,
  pace: "",
  color: "bg-slate-500",
  textColor: "text-white",
};

function VirtualTrackList({ tracks, onDelete, onSimilar, onSuggest, suggestBusy, inlineCard }: {
  tracks: TrackWithBPM[];
  onDelete?: (track: TrackWithBPM) => void;
  onSimilar?: (track: TrackWithBPM) => void;
  onSuggest?: (track: TrackWithBPM, mode: "style" | "tempo") => void;
  suggestBusy?: { trackId: string; mode: "style" | "tempo" } | null;
  /** Card rendered inline directly below the row whose track id matches (suggestions popover) */
  inlineCard?: { trackId: string; node: React.ReactNode } | null;
}) {
  const [visibleCount, setVisibleCount] = useState(50);
  const containerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);

  const loadMore = useCallback(() => {
    setVisibleCount(c => Math.min(c + 50, tracks.length));
  }, [tracks.length]);

  useEffect(() => {
    const container = containerRef.current;
    const sentinel = sentinelRef.current;
    if (!container || !sentinel || visibleCount >= tracks.length) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) loadMore(); },
      { root: container, rootMargin: "120px" },
    );
    obs.observe(sentinel);
    return () => obs.disconnect();
  }, [visibleCount, tracks.length, loadMore]);

  return (
    <div ref={containerRef} className="divide-y divide-slate-800/50 max-h-[600px] overflow-y-auto no-scrollbar">
      {tracks.slice(0, visibleCount).map((track, i) => (
        <div
          key={`${track.id}-${i}`}
          ref={inlineCard?.trackId === track.id
            ? (el) => { if (el) setAnchorEl(prev => (prev === el ? prev : el)); }
            : undefined}
        >
          <TrackRow
            track={track}
            index={i}
            onDelete={onDelete ? () => onDelete(track) : undefined}
            onSimilar={onSimilar ? () => onSimilar(track) : undefined}
            onSuggestStyle={onSuggest ? () => onSuggest(track, "style") : undefined}
            onSuggestTempo={onSuggest ? () => onSuggest(track, "tempo") : undefined}
            suggestBusy={suggestBusy?.trackId === track.id ? suggestBusy.mode : null}
          />
        </div>
      ))}
      {inlineCard && (
        <FloatingCard anchor={anchorEl}>{inlineCard.node}</FloatingCard>
      )}
      {visibleCount < tracks.length && (
        <div ref={sentinelRef} className="py-2 text-center text-xs text-slate-600">
          {visibleCount} of {tracks.length}
        </div>
      )}
    </div>
  );
}

const RUNNING_PLAYLIST_ID = process.env.NEXT_PUBLIC_RUNNING_PLAYLIST_ID ?? "";
const TODAYS_RUN_PLAYLIST = "Today's Run";

const BBC_DEFAULTS = [
  { pid: "m001j52w", name: "6 Music Playlist", synopsis: "" },
  { pid: "m0012v02", name: "6 Music's Indie Forever", synopsis: "" },
  { pid: "m002xsbn", name: "Lauren Laverne", synopsis: "" },
];

interface Props {
  spotifyUser: { name: string; image: string | null };
}

type Step = "idle" | "ready" | "saving" | "saved" | "partial";

interface Suggestion {
  name: string;
  artist: string;
  bpm: number;
  camelot: string;
  spotifyUrl: string | null;
  distance: number;
  tempo: number;
  key: number;
  mode: number;
  energy: number;
  danceability: number;
  valence: number;
}

function spotifyIdFromUrl(url: string | null): string | null {
  const m = url?.match(/open\.spotify\.com\/track\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

// BBC card tracks are a slimmer shape — lift one into a TrackWithBPM so the
// similar/suggest handlers can treat all seeds uniformly.
function bbcToTrack(t: { uri: string; name: string; artistName: string }): TrackWithBPM {
  return {
    id: t.uri.split(":")[2] ?? t.uri,
    name: t.name,
    artists: [{ name: t.artistName }],
    album: { name: "", images: [] },
    duration_ms: 0,
    uri: t.uri,
    bpm: 0,
    energy: 0,
  };
}

interface SuggestState {
  seed: TrackWithBPM;
  mode: "style" | "tempo";
  origin: "list" | "bbc";
  progress: string;
  results: Suggestion[] | null;
  error: string | null;
}

// Parse a single CSV row, handling quoted fields
function parseCsvRow(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === "," && !inQuotes) { result.push(current.trim()); current = ""; }
    else { current += ch; }
  }
  result.push(current.trim());
  return result;
}

type CsvParseResult =
  | { ok: true; tracks: TrackWithBPM[] }
  | { ok: false; error: string };

function parseExportifyCsv(text: string): CsvParseResult {
  // Strip UTF-8 BOM if present (U+FEFF = char code 65279)
  const stripped = text.charCodeAt(0) === 65279 ? text.slice(1) : text;
  const cleaned = stripped.replace(/\r/g, "");
  const lines = cleaned.split("\n").filter(Boolean);
  if (lines.length < 2) return { ok: false, error: "File appears to be empty." };

  const headers = parseCsvRow(lines[0]);
  const col = (...names: string[]) =>
    headers.findIndex(h => names.some(n => h.trim().toLowerCase() === n.toLowerCase()));

  // Accept "Track URI" (current Exportify), "Spotify URI", "Spotify ID"
  const idxId       = col("Track URI", "Spotify URI", "Spotify ID", "uri", "id");
  const idxName     = col("Track Name", "Name", "Song", "Title");
  const idxArtist   = col("Artist Name(s)", "Artist", "Artists");
  const idxAlbum    = col("Album Name", "Album");
  const idxDuration = col("Track Duration (ms)", "Duration (ms)", "Duration");
  const idxBpm      = col("BPM", "Tempo", "bpm", "tempo");
  const idxEnergy   = col("Energy", "energy");

  if (idxId === -1 || idxName === -1) {
    return {
      ok: false,
      error: `Could not find track columns. Found: ${headers.join(", ")}`,
    };
  }

  const hasBpm = idxBpm !== -1;
  const tracks: TrackWithBPM[] = [];

  for (let i = 1; i < lines.length; i++) {
    const row = parseCsvRow(lines[i]);
    let raw = row[idxId]?.trim() ?? "";
    // Exportify new format uses full URI like "spotify:track:XXXX"
    const id = raw.startsWith("spotify:track:") ? raw.slice("spotify:track:".length) : raw;
    if (!id) continue;

    const bpm = hasBpm ? parseFloat(row[idxBpm]) : 0;
    tracks.push({
      id,
      name:        row[idxName]  ?? "Unknown",
      artists:     [{ name: row[idxArtist] ?? "Unknown" }],
      album:       { name: row[idxAlbum] ?? "", images: [] },
      duration_ms: parseInt(row[idxDuration] ?? "0") || 0,
      uri:         id.startsWith("spotify:") ? id : `spotify:track:${id}`,
      bpm:         hasBpm && !isNaN(bpm) && bpm > 0 ? Math.round(bpm) : 0,
      energy:      parseFloat(row[idxEnergy] ?? "0") || 0,
    });
  }

  if (tracks.length === 0) {
    return { ok: false, error: `Parsed ${lines.length - 1} rows but found no valid tracks. Headers: ${headers.join(", ")}` };
  }

  const withBpm = tracks.filter(t => t.bpm > 0).length;
  if (withBpm === 0) {
    return {
      ok: false,
      error: `Found ${tracks.length} tracks but none have BPM data. Exportify may have removed BPM from exports — see instructions below.`,
    };
  }

  return { ok: true, tracks };
}

export function DashboardClient({ spotifyUser }: Props) {
  const { data: session } = useSession();
  const [zones, setZones]               = useState<RunningZone[]>([]);
  const [selectedZones, setSelectedZones] = useState<RunningZone[]>([]);
  const [allTracks, setAllTracks]       = useState<TrackWithBPM[]>([]);
  const [filteredTracks, setFilteredTracks] = useState<TrackWithBPM[]>([]);
  const [csvName, setCsvName]           = useState<string | null>(null);
  const [step, setStep]                 = useState<Step>("idle");
  const [savedUrl, setSavedUrl]         = useState<string | null>(null);
  const [pendingUris, setPendingUris]   = useState<string[]>([]);
  const [copied, setCopied]             = useState(false);
  const [playlistName, setPlaylistName] = useState("");
  const [saveError, setSaveError]       = useState<string | null>(null);
  const [bbcProgrammes, setBbcProgrammes] = useState<{ pid: string; name: string; synopsis?: string }[]>(BBC_DEFAULTS);
  const [garminConfigured, setGarminConfigured] = useState(false);
  const [aiDjEnabled, setAiDjEnabled] = useState(false);
  const [paceFilter, setPaceFilter] = useState<{ paces: Array<{ paceStr: string; bpm: number }> } | null>(null);
  const [similarFilter, setSimilarFilter] = useState<{ seed: TrackWithBPM; uris: string[] } | null>(null);
  const [similarLoading, setSimilarLoading] = useState(false);
  const [suggest, setSuggest] = useState<SuggestState | null>(null);
  const suggestSourceRef = useRef<EventSource | null>(null);
  const [noBpmFilter, setNoBpmFilter] = useState(false);
  const [similarNotice, setSimilarNotice] = useState<string | null>(null);
  const [enriching, setEnriching] = useState(false);
  const [enrichMsg, setEnrichMsg] = useState<string | null>(null);
  const enrichAttempted = useRef(false);
  const [aiDjMix, setAiDjMix] = useState<{ workoutTitle: string; name: string; tracks: TrackWithBPM[]; totalSec: number; segments: string[]; stale: boolean } | null>(null);
  const [remixing, setRemixing] = useState(false);
  const [todaysRunSaving, setTodaysRunSaving] = useState(false);
  const [todaysRunSaved, setTodaysRunSaved] = useState(false);
  const [todaysRunError, setTodaysRunError] = useState<string | null>(null);
  const [todaysRunUrl, setTodaysRunUrl] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/settings/garmin")
      .then(r => r.json())
      .then((d: { configured?: boolean }) => { setGarminConfigured(d.configured ?? false); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/settings/ai-dj")
      .then(r => r.json())
      .then((d: { enabled?: boolean }) => { setAiDjEnabled(d.enabled ?? false); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/bbc/programmes")
      .then(r => r.json())
      .then((d: { programmes?: { pid: string; name: string }[] }) => {
        if (d.programmes?.length) setBbcProgrammes(d.programmes);
      })
      .catch(() => {});
  }, []);

  async function saveBbcProgrammes(list: { pid: string; name: string }[]) {
    setBbcProgrammes(list);
    fetch("/api/bbc/programmes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ programmes: list }),
    }).catch(() => {});
  }

  function handleAddBbcProgramme(prog: { pid: string; name: string; synopsis?: string }) {
    const updated = bbcProgrammes.some(p => p.pid === prog.pid)
      ? bbcProgrammes
      : [...bbcProgrammes, prog];
    saveBbcProgrammes(updated);
  }

  function handleRemoveBbcProgramme(pid: string) {
    saveBbcProgrammes(bbcProgrammes.filter(p => p.pid !== pid));
  }

  useEffect(() => {
    fetch("/api/settings/hr-zones")
      .then(r => r.json())
      .then((d: { zones?: RunningZone[] }) => { if (d.zones) setZones(d.zones); })
      .catch(() => {});
  }, []);

  // Auto-load default playlist on mount
  useEffect(() => {
    fetch("/Running.csv")
      .then((r) => r.text())
      .then((text) => {
        const result = parseExportifyCsv(text);
        if (!result.ok) return;
        setCsvName("Running");
        setAllTracks(result.tracks);
        setStep("ready");
        // Start on the full playlist so the track list is populated immediately
        setSelectedZones([ALL_ZONE]);
        setPlaylistName("Running");
        prewarmArt(result.tracks);
      })
      .catch(() => {/* silently ignore if file missing */});
  }, []);

  // Enrich BPM-less tracks via ReccoBeats; updates the CSV and local state.
  // Returns how many tracks got features.
  const runEnrichment = useCallback(async (missing: TrackWithBPM[]): Promise<number> => {
    if (missing.length === 0) return 0;
    const er = await fetch("/api/bpm/enrich", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tracks: missing.map(t => ({ id: t.id, name: t.name, artist: t.artists[0]?.name ?? "" })),
      }),
    });
    const ed = await er.json() as {
      features?: Record<string, { tempo: number; key: number; mode: number; energy: number; danceability: number; valence: number }>;
    };
    const features = ed.features ?? {};
    const rows = missing.flatMap(t => {
      const f = features[t.id];
      return f ? [{ uri: t.uri, ...f }] : [];
    });
    if (rows.length === 0) return 0;

    await fetch("/api/tracks/update-features", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tracks: rows }),
    });

    setAllTracks(prev => prev.map(t => {
      const f = features[t.id];
      return f && t.bpm === 0 ? { ...t, bpm: Math.round(f.tempo), energy: f.energy } : t;
    }));
    return rows.length;
  }, []);

  // Auto-enrich on load: any track missing BPM gets a ReccoBeats lookup once per session
  useEffect(() => {
    if (enrichAttempted.current || allTracks.length === 0) return;
    const missing = allTracks.filter(t => t.bpm === 0);
    if (missing.length === 0) return;
    enrichAttempted.current = true;
    runEnrichment(missing).catch(() => {});
  }, [allTracks, runEnrichment]);

  // Re-filter whenever zone selection, pace filter, similar filter, or tracks change
  useEffect(() => {
    if (aiDjMix) {
      setFilteredTracks(aiDjMix.tracks);
      return;
    }
    if (allTracks.length === 0) return;
    if (noBpmFilter) {
      setFilteredTracks(allTracks.filter(t => t.bpm === 0));
      return;
    }
    if (similarFilter) {
      const byUri = new Map(allTracks.map(t => [t.uri, t]));
      const ranked = similarFilter.uris
        .map(u => byUri.get(u))
        .filter((t): t is TrackWithBPM => t !== undefined);
      setFilteredTracks([similarFilter.seed, ...ranked.filter(t => t.uri !== similarFilter.seed.uri)]);
      return;
    }
    if (paceFilter && paceFilter.paces.length > 0) {
      const bpms = paceFilter.paces.map(p => p.bpm);
      const lo = Math.min(...bpms) - 2, hi = Math.max(...bpms) + 2;
      setFilteredTracks(allTracks.filter(t => t.bpm >= lo && t.bpm <= hi));
      return;
    }
    if (selectedZones.length === 0) return;
    if (selectedZones.some(z => z.number === 0)) {
      setFilteredTracks(allTracks);
    } else {
      const seen = new Set<string>();
      const result: TrackWithBPM[] = [];
      const sorted = [...selectedZones].sort((a, b) => a.bpmMin - b.bpmMin);
      for (const zone of sorted) {
        for (const t of filterTracksByBPM(allTracks, zone.bpmMin, zone.bpmMax)) {
          if (!seen.has(t.uri)) { seen.add(t.uri); result.push(t); }
        }
      }
      setFilteredTracks(result);
    }
  }, [selectedZones, allTracks, paceFilter, similarFilter, noBpmFilter, aiDjMix]);

  // For seeds not in the playlist pool (BBC tracks, 0-BPM tracks) the CSV
  // lookup in the python bridge can't work — fetch features from ReccoBeats
  // and pass them along explicitly. Returns null when the CSV lookup is fine.
  async function seedFeaturesFor(track: TrackWithBPM): Promise<
    { name: string; artist: string; tempo: number; key: number; mode: number; energy: number; danceability: number; valence: number } | null
  > {
    const inPool = allTracks.some(t => t.uri === track.uri && t.bpm > 0);
    if (inPool) return null;
    const res = await fetch("/api/bpm/enrich", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tracks: [{ id: track.id, name: track.name, artist: track.artists[0]?.name ?? "" }] }),
    });
    const d = await res.json() as {
      features?: Record<string, { tempo: number; key: number; mode: number; energy: number; danceability: number; valence: number }>;
    };
    const f = d.features?.[track.id];
    if (!f) throw new Error(`No audio data found for "${track.name}" — can't search`);
    return { name: track.name, artist: track.artists[0]?.name ?? "", ...f };
  }

  async function handleSimilar(track: TrackWithBPM) {
    setSimilarLoading(true);
    try {
      const seed = await seedFeaturesFor(track);
      const seedTrack = seed && track.bpm === 0 ? { ...track, bpm: Math.round(seed.tempo) } : track;
      const res = await fetch("/api/bpm/similar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uri: track.uri, n: 30, seed: seed ?? undefined }),
      });
      const data = await res.json() as { error?: string; matches?: { uri: string; distance: number }[] };
      if (data.error) throw new Error(data.error);
      setSimilarFilter({ seed: seedTrack, uris: (data.matches ?? []).map(m => m.uri) });
      setSelectedZones([]);
      setPaceFilter(null);
      setNoBpmFilter(false);
      setAiDjMix(null);
      if (csvName) setPlaylistName(`${csvName} – like ${track.name}`);
    } catch (e) {
      console.error("[similar]", e);
      setSimilarNotice(e instanceof Error ? e.message : "Similar search failed");
      setTimeout(() => setSimilarNotice(null), 5000);
    } finally {
      setSimilarLoading(false);
    }
  }

  // Populates the central track list/save UI from an AI DJ mix (built in
  // RunnaScheduleCard) instead of saving straight to Spotify — the user picks
  // which playlist(s) to save to from here.
  function handleAiDjMix(workoutTitle: string, name: string, tracks: TrackWithBPM[], totalSec: number, segments: string[]) {
    setSelectedZones([]);
    setPaceFilter(null);
    setSimilarFilter(null);
    setNoBpmFilter(false);
    const unique = tracks.filter((t, i, a) => a.findIndex(x => x.uri === t.uri) === i);
    setAiDjMix({ workoutTitle, name, tracks: unique, totalSec, segments, stale: false });
    setPlaylistName(name);
    setStep("ready");
    setSaveError(null);
    setSavedUrl(null);
    setTodaysRunSaving(false);
    setTodaysRunSaved(false);
    setTodaysRunError(null);
    setTodaysRunUrl(null);
  }

  // Rebuild the AI DJ mix from the same workout segments after the library
  // changed (a track in the mix was deleted).
  async function remixAiDjMix() {
    if (!aiDjMix) return;
    setRemixing(true);
    setSaveError(null);
    // Clear the old tracks immediately so the stale mix can't linger (or be
    // saved) while the rebuild runs.
    setAiDjMix(prev => prev ? { ...prev, tracks: [] } : prev);
    try {
      const res = await fetch("/api/ai-dj/mix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: aiDjMix.workoutTitle, segments: aiDjMix.segments }),
      });
      const mix = await res.json() as {
        error?: string;
        trackUris?: string[];
        totalSec?: number;
        timeline?: { tracks: { uri: string; name: string; artist: string; tempo: number; energy: number }[] }[];
      };
      if (!res.ok || mix.error) throw new Error(mix.error ?? `Mix failed (${res.status})`);
      const tracks: TrackWithBPM[] = (mix.timeline ?? []).flatMap(seg => seg.tracks).map(t => ({
        id: t.uri.split(":")[2] ?? t.uri,
        name: t.name,
        artists: [{ name: t.artist }],
        album: { name: "", images: [] },
        duration_ms: 0,
        uri: t.uri,
        bpm: Math.round(t.tempo),
        energy: t.energy,
      })).filter((t, i, a) => a.findIndex(x => x.uri === t.uri) === i);
      if (tracks.length === 0) throw new Error("No tracks matched this workout");
      setAiDjMix(prev => prev ? { ...prev, tracks, totalSec: mix.totalSec ?? prev.totalSec, stale: false } : prev);
      setStep("ready");
      setSavedUrl(null);
      setTodaysRunSaved(false);
      setTodaysRunUrl(null);
      setTodaysRunError(null);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Remix failed");
    } finally {
      setRemixing(false);
    }
  }

  async function saveTodaysRun() {
    if (!filteredTracks.length) return;
    setTodaysRunSaving(true);
    setTodaysRunError(null);
    try {
      const res = await fetch("/api/spotify/create-playlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: TODAYS_RUN_PLAYLIST,
          description: aiDjMix
            ? `AI DJ mix for Runna workout "${aiDjMix.workoutTitle}" — pace-matched to each segment`
            : "PaceSync running playlist for today",
          trackUris: filteredTracks.map((t) => t.uri),
        }),
      });
      const data = await res.json() as { error?: string; url?: string; tracksAdded?: boolean; trackUris?: string[] };
      if (data.error) throw new Error(data.error);
      setTodaysRunUrl(data.url ?? null);
      if (data.tracksAdded === false && data.url) {
        const playlistId = data.url.split("/").pop()!;
        try {
          await addTracksBrowser(playlistId, data.trackUris ?? filteredTracks.map((t) => t.uri));
          setTodaysRunSaved(true);
        } catch (e) {
          setTodaysRunError(e instanceof Error ? e.message : "Playlist created but adding tracks failed");
        }
      } else {
        setTodaysRunSaved(true);
      }
    } catch (e) {
      setTodaysRunError(e instanceof Error ? e.message : "Failed to save playlist");
    } finally {
      setTodaysRunSaving(false);
    }
  }

  async function handleSuggest(track: TrackWithBPM, mode: "style" | "tempo", origin: "list" | "bbc" = "list") {
    suggestSourceRef.current?.close();
    setSuggest({ seed: track, mode, origin, progress: "Starting search…", results: null, error: null });

    let seedParam = "";
    try {
      const seed = await seedFeaturesFor(track);
      if (seed) {
        seedParam = `&seed=${encodeURIComponent(JSON.stringify(seed))}`;
        if (track.bpm === 0) {
          const bpm = Math.round(seed.tempo);
          setSuggest(s => s && { ...s, seed: { ...s.seed, bpm } });
        }
      }
    } catch (e) {
      setSuggest(s => s && { ...s, error: e instanceof Error ? e.message : "No audio data for this track" });
      return;
    }

    const es = new EventSource(`/api/bpm/suggest?uri=${encodeURIComponent(track.uri)}&mode=${mode}${seedParam}`);
    suggestSourceRef.current = es;
    es.onmessage = (ev) => {
      const data = JSON.parse(ev.data) as {
        progress?: string;
        error?: string;
        done?: boolean;
        result?: { suggestions: Suggestion[] };
      };
      if (data.progress) {
        setSuggest(s => s && { ...s, progress: data.progress! });
      }
      if (data.error) {
        setSuggest(s => s && { ...s, error: data.error! });
        es.close();
      }
      if (data.done && data.result) {
        setSuggest(s => s && { ...s, results: data.result!.suggestions });
        es.close();
      }
    };
    es.onerror = () => {
      setSuggest(s => s && s.results === null && !s.error ? { ...s, error: "Connection lost" } : s);
      es.close();
    };
  }

  // Add accepted suggestions to the Spotify Running playlist + the local CSV pool
  async function handleAddSuggestions(items: Suggestion[]): Promise<void> {
    const withIds = items
      .map(s => ({ s, id: spotifyIdFromUrl(s.spotifyUrl) }))
      .filter((x): x is { s: Suggestion; id: string } => x.id !== null);
    if (withIds.length === 0) throw new Error("No Spotify IDs found for selected tracks");

    const uris = withIds.map(x => `spotify:track:${x.id}`);
    if (RUNNING_PLAYLIST_ID) {
      await addTracksBrowser(RUNNING_PLAYLIST_ID, uris);
    }

    await fetch("/api/tracks/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tracks: withIds.map(({ s, id }) => ({
          uri: `spotify:track:${id}`,
          name: s.name,
          artist: s.artist,
          tempo: s.tempo,
          key: s.key,
          mode: s.mode,
          energy: s.energy,
          danceability: s.danceability,
          valence: s.valence,
        })),
      }),
    });

    setAllTracks(prev => {
      const existing = new Set(prev.map(t => t.uri));
      const added: TrackWithBPM[] = withIds
        .filter(({ id }) => !existing.has(`spotify:track:${id}`))
        .map(({ s, id }) => ({
          id,
          name: s.name,
          artists: [{ name: s.artist }],
          album: { name: "", images: [] },
          duration_ms: 0,
          uri: `spotify:track:${id}`,
          bpm: s.bpm,
          energy: s.energy,
        }));
      return [...prev, ...added];
    });
  }

  async function handleDeleteTrack(track: TrackWithBPM) {
    const token = session?.accessToken;

    // Optimistically remove from local state immediately
    setAllTracks(prev => prev.filter(t => t.id !== track.id));

    // Deleting a track out of an AI DJ mix invalidates it — the mix was
    // built against a library that no longer exists. Mark it stale so the
    // save buttons give way to a Remix button.
    setAiDjMix(prev => {
      if (!prev || !prev.tracks.some(t => t.id === track.id)) return prev;
      return { ...prev, tracks: prev.tracks.filter(t => t.id !== track.id), stale: true };
    });

    const fullUri = track.uri.startsWith("spotify:") ? track.uri : `spotify:track:${track.uri}`;

    // Remove from Spotify directly from browser (same pattern as DedupCard)
    if (token) {
      fetch(`https://api.spotify.com/v1/playlists/${RUNNING_PLAYLIST_ID}/items`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ uri: fullUri }] }),
      }).then(async (r) => {
        if (!r.ok) {
          const body = await r.text().catch(() => "");
          console.error(`[delete] Spotify ${r.status}: ${body}`);
        }
      }).catch((err) => { console.error("[delete] Spotify fetch error:", err); });
    } else {
      console.warn("[delete] No Spotify access token — skipping Spotify removal");
    }

    // Remove from CSV (server-side file write)
    fetch("/api/tracks/delete", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spotifyUri: fullUri }),
    }).catch(() => {});
  }


  const savePlaylist = async () => {
    if (!filteredTracks.length || !playlistName) return;
    setStep("saving");
    setSaveError(null);
    try {
      const res = await fetch("/api/spotify/create-playlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: playlistName,
          description: aiDjMix
            ? `AI DJ mix for Runna workout "${aiDjMix.workoutTitle}" — pace-matched to each segment`
            : `PaceSync: zones ${selectedZones.map(z => z.number).sort().join(",")} (${selectedZones.map(z => `${z.bpmMin}–${z.bpmMax}`).join(", ")} BPM)`,
          trackUris: filteredTracks.map((t) => t.uri),
        }),
      });
      const data = await res.json() as {
        error?: string;
        url?: string;
        tracksAdded?: boolean;
        trackUris?: string[];
      };
      if (data.error) throw new Error(data.error);
      setSavedUrl(data.url ?? null);
      if (data.tracksAdded === false && data.url) {
        // Server-side add blocked by Spotify — try directly from the browser
        const playlistId = data.url.split("/").pop()!;
        try {
          await addTracksBrowser(playlistId, data.trackUris ?? filteredTracks.map((t) => t.uri));
          setStep("saved");
        } catch {
          setPendingUris(data.trackUris ?? filteredTracks.map((t) => t.uri));
          setStep("partial");
        }
      } else {
        setStep("saved");
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Failed to save playlist");
      setStep("ready");
    }
  };

  async function addTracksBrowser(playlistId: string, uris: string[]): Promise<void> {
    const token = session?.accessToken;
    if (!token) throw new Error("No access token");
    for (let i = 0; i < uris.length; i += 100) {
      const res = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/items`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ uris: uris.slice(i, i + 100) }),
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Spotify ${res.status}: ${err}`);
      }
    }
  }

const displayZones = zones.length > 0 ? zones : getDefaultZones();

  const suggestCardNode = suggest ? (
    <SuggestionsCard
      key={`${suggest.seed.id}-${suggest.mode}`}
      suggest={suggest}
      onClose={() => { suggestSourceRef.current?.close(); setSuggest(null); }}
      onAdd={handleAddSuggestions}
    />
  ) : null;
  const suggestSeedVisible = suggest !== null && suggest.origin === "list" && filteredTracks.some(t => t.id === suggest.seed.id);

  return (
    <div
      className="min-h-screen flex flex-col bg-cover bg-fixed bg-center bg-no-repeat"
      style={{ backgroundImage: "linear-gradient(rgba(2,6,23,0.65), rgba(2,6,23,0.65)), url('/dashboard-hero.png')" }}
    >
      {/* Header */}
      <header className="border-b border-white/5 bg-slate-950/70 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-[1800px] mx-auto px-4 h-14 flex items-center justify-between">
          <span className="font-bold text-green-400 text-lg tracking-tight">PaceSync</span>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 text-sm text-slate-400">
              {spotifyUser.image && (
                <img src={spotifyUser.image} alt="" className="h-7 w-7 rounded-full" />
              )}
              <span>{spotifyUser.name}</span>
            </div>
            {garminConfigured && (
              <Link href="/garmin" className="text-xs text-slate-500 hover:text-slate-300 transition-colors">
                Garmin
              </Link>
            )}
            <Link
              href="/settings"
              className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
            >
              Settings
            </Link>
            <button
              onClick={async () => {
                // Clear the local-auth gate first so signing back in requires
                // username/password (+ 2FA), not just the Spotify OAuth.
                await fetch("/api/local-auth/logout", { method: "POST" }).catch(() => {});
                signOut({ callbackUrl: "/" });
              }}
              className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-[1800px] mx-auto px-4 py-8 flex-1 w-full">
        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] xl:grid-cols-[280px_1fr_570px] gap-6">

          {/* Col 1: Zones */}
          <aside className="space-y-4">
            <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
                <h2 className="font-semibold text-sm">Heart Rate Zones</h2>
                <Link
                  href="/settings"
                  className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
                >
                  Edit zones →
                </Link>
              </div>
              <div className="p-2 space-y-1.5">

            {zones.length === 0 && (
              <div className="space-y-2">
                {[1,2,3,4,5].map(n => (
                  <div key={n} className="h-20 rounded-lg bg-slate-900 animate-pulse" />
                ))}
              </div>
            )}

            <div className="space-y-2">
              {/* All Songs tile */}
              <button
                onClick={() => {
                  setPaceFilter(null);
                  setSimilarFilter(null);
                  setNoBpmFilter(false);
                  setAiDjMix(null);
                  setSelectedZones([ALL_ZONE]);
                  if (csvName) setPlaylistName(csvName);
                }}
                className={`w-full rounded-lg border p-4 text-left transition-all ${
                  selectedZones.some(z => z.number === 0)
                    ? "border-green-500 bg-green-500/10 backdrop-blur-sm ring-1 ring-green-500"
                    : "border-white/10 bg-slate-900/85 backdrop-blur-sm hover:border-white/20"
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">All Songs</span>
                  {allTracks.length > 0 && (
                    <span className="text-xs text-slate-400">{allTracks.length} tracks</span>
                  )}
                </div>
                <p className="font-semibold text-sm">Complete Playlist</p>
                <p className="text-xs text-slate-500 mt-0.5">All BPM ranges</p>
                {allTracks.length > 0 && (() => {
                  const noBpm = allTracks.filter(t => t.bpm === 0).length;
                  return (
                    <span
                      onClick={noBpm > 0 ? (e) => {
                        e.stopPropagation();
                        setSelectedZones([]);
                        setPaceFilter(null);
                        setSimilarFilter(null);
                        setNoBpmFilter(true);
                        setAiDjMix(null);
                        setEnrichMsg(null);
                      } : undefined}
                      className={`block text-xs mt-0.5 ${
                        noBpm > 0
                          ? `text-red-400 ${noBpmFilter ? "font-semibold underline" : "hover:underline cursor-pointer"}`
                          : "text-green-700"
                      }`}
                      title={noBpm > 0 ? "Show these tracks so you can fix or remove them" : undefined}
                    >
                      {noBpm} Tracks without BPM info
                    </span>
                  );
                })()}
              </button>

              {displayZones.map((zone) => (
                <ZoneCard
                  key={zone.number}
                  zone={zone}
                  selected={selectedZones.some(z => z.number === zone.number)}
                  onClick={(e) => {
                    setPaceFilter(null);
                    setSimilarFilter(null);
                    setNoBpmFilter(false);
                    setAiDjMix(null);
                    if (e.ctrlKey || e.metaKey) {
                      setSelectedZones(prev => {
                        const withoutAll = prev.filter(z => z.number !== 0);
                        const exists = withoutAll.some(z => z.number === zone.number);
                        const next = exists
                          ? withoutAll.filter(z => z.number !== zone.number)
                          : [...withoutAll, zone];
                        const sorted = [...next].sort((a, b) => a.number - b.number);
                        if (csvName && sorted.length > 0)
                          setPlaylistName(sorted.length === 1
                            ? `${csvName} – ${sorted[0].name}`
                            : `${csvName} – Z${sorted.map(z => z.number).join("")}`);
                        return next;
                      });
                    } else {
                      setSelectedZones([zone]);
                      if (csvName) setPlaylistName(`${csvName} – ${zone.name}`);
                    }
                  }}
                />
              ))}
            </div>

              </div>
            </div>

            <DedupCard />
          </aside>

          {/* Col 2: Main content */}
          <main className="space-y-6 min-w-0">

            {/* Target zone */}
            {csvName && (
              <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5 space-y-3">
                <h2 className="font-semibold">Target zone</h2>
                <div className="rounded-lg bg-slate-800/50 border border-white/10 px-3 py-2 text-sm">
                  {aiDjMix ? (
                    <span className="text-purple-400 font-medium">
                      🎧 AI DJ Mix — &quot;{aiDjMix.workoutTitle}&quot; · {Math.round(aiDjMix.totalSec / 60)} min
                    </span>
                  ) : noBpmFilter ? (
                    <span className="text-red-400 font-medium">
                      Tracks without BPM info — fix with a BPM lookup, delete, or re-export via Exportify
                    </span>
                  ) : similarFilter ? (
                    <span className="text-purple-400 font-medium">
                      Songs like &quot;{similarFilter.seed.name}&quot; — {similarFilter.seed.artists[0]?.name} · {similarFilter.seed.bpm} BPM
                    </span>
                  ) : paceFilter && paceFilter.paces.length > 0 ? (() => {
                    const bpms = paceFilter.paces.map(p => p.bpm);
                    const lo = Math.min(...bpms) - 2, hi = Math.max(...bpms) + 2;
                    const labels = [...paceFilter.paces].sort((a, b) => a.bpm - b.bpm).map(p => p.paceStr).join(", ");
                    return <span className="text-orange-400 font-medium">{labels}/mi pace · ♪ {lo}–{hi} BPM</span>;
                  })() : selectedZones.length === 0 ? (
                    <span className="text-slate-500">← Select a zone on the left</span>
                  ) : selectedZones.some(z => z.number === 0) ? (
                    <span className="text-green-400 font-medium">All Songs — all BPM ranges</span>
                  ) : selectedZones.length === 1 ? (
                    <span className="text-green-400 font-medium">
                      Zone {selectedZones[0].number} — {selectedZones[0].name} · ♪ {selectedZones[0].bpmMin}–{selectedZones[0].bpmMax} BPM music
                    </span>
                  ) : (
                    <span className="text-green-400 font-medium">
                      {(() => { const s = [...selectedZones].sort((a,b) => a.number - b.number); return `Zones ${s.map(z => z.number).join(", ")} · ♪ ${s.map(z => `${z.bpmMin}–${z.bpmMax}`).join(" & ")} BPM`; })()}
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Results */}
            {step !== "idle" && csvName && (selectedZones.length > 0 || (paceFilter && paceFilter.paces.length > 0) || similarFilter || noBpmFilter || aiDjMix) && (
              <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 overflow-hidden">
                <div className="p-5 border-b border-white/10 flex items-start justify-between gap-4 flex-wrap">
                  <div>
                    <h3 className="font-semibold">
                      {(() => {
                        if (aiDjMix) return `${filteredTracks.length} tracks in AI DJ mix for "${aiDjMix.workoutTitle}"`;
                        if (noBpmFilter) return `${filteredTracks.length} tracks without BPM info`;
                        if (similarFilter) return `${filteredTracks.length} songs like "${similarFilter.seed.name}"`;
                        if (paceFilter && paceFilter.paces.length > 0) {
                          const bpms = paceFilter.paces.map(p => p.bpm);
                          const lo = Math.min(...bpms) - 2, hi = Math.max(...bpms) + 2;
                          const labels = [...paceFilter.paces].sort((a, b) => a.bpm - b.bpm).map(p => p.paceStr).join(", ");
                          return `${filteredTracks.length} tracks matching ${labels}/mi (${lo}–${hi} BPM)`;
                        }
                        if (selectedZones.some(z => z.number === 0)) return `${filteredTracks.length} tracks in zone 0 (0–9999 BPM)`;
                        const s = [...selectedZones].sort((a,b) => a.number - b.number);
                        const zLabel = s.length === 1 ? `zone ${s[0].number} (${s[0].bpmMin}–${s[0].bpmMax} BPM)` : `zones ${s.map(z=>z.number).join("+")} (${s.map(z=>`${z.bpmMin}–${z.bpmMax}`).join(", ")} BPM)`;
                        return `${filteredTracks.length} tracks in ${zLabel}`;
                      })()}
                    </h3>
                    <p className="text-sm text-slate-500 mt-0.5">
                      From {allTracks.length} total tracks in "{csvName}"
                    </p>
                  </div>

                  {noBpmFilter && filteredTracks.length > 0 && (
                    <div className="flex flex-col items-end gap-1.5 shrink-0">
                      <button
                        onClick={async () => {
                          setEnriching(true);
                          setEnrichMsg(null);
                          try {
                            const found = await runEnrichment(filteredTracks);
                            setEnrichMsg(found > 0
                              ? `Found BPM data for ${found} track${found !== 1 ? "s" : ""}`
                              : "No BPM data found — these tracks aren't in ReccoBeats");
                          } catch (e) {
                            setEnrichMsg(e instanceof Error ? e.message : "Lookup failed");
                          } finally {
                            setEnriching(false);
                          }
                        }}
                        disabled={enriching}
                        className="inline-flex items-center gap-2 rounded-lg bg-green-500 hover:bg-green-400 disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold text-xs px-4 py-1.5 transition-colors"
                      >
                        {enriching ? <><Spinner />Looking up…</> : "Retry BPM lookup"}
                      </button>
                      {enrichMsg && <p className="text-xs text-slate-400">{enrichMsg}</p>}
                    </div>
                  )}

                  {!noBpmFilter && step !== "partial" && aiDjMix?.stale && (
                    <div className="flex flex-col items-end gap-1.5 shrink-0">
                      <button
                        onClick={remixAiDjMix}
                        disabled={remixing}
                        className="inline-flex items-center justify-center gap-2 rounded-lg bg-purple-500 hover:bg-purple-400 disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold text-xs px-4 py-1.5 transition-colors"
                      >
                        {remixing ? <><Spinner />Remixing…</> : "🎧 Remix"}
                      </button>
                      <p className="text-xs text-slate-500 max-w-[220px] text-right">
                        Tracks were deleted — remix to rebuild the playlist without them.
                      </p>
                    </div>
                  )}

                  {!noBpmFilter && filteredTracks.length > 0 && step !== "partial" && !aiDjMix?.stale && (
                    <div className="flex items-start gap-2 shrink-0">
                      <label className="text-xs text-slate-500 whitespace-nowrap pt-1.5">Spotify playlist name</label>
                      <div className="flex flex-col gap-1.5">
                        <input
                          type="text"
                          value={playlistName}
                          onChange={(e) => setPlaylistName(e.target.value)}
                          placeholder="Playlist name"
                          className="rounded-lg bg-slate-800 border border-slate-700 text-xs px-3 py-1.5 text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-green-500 w-40"
                        />
                      <button
                        onClick={savePlaylist}
                        disabled={!playlistName || step === "saving"}
                        className="inline-flex items-center justify-center gap-2 rounded-lg bg-green-500 hover:bg-green-400 disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold text-xs px-4 py-1.5 transition-colors w-full"
                      >
                        {step === "saving" ? <><Spinner />Saving…</> : "Save to Spotify"}
                      </button>
                      {aiDjMix && (
                        <button
                          onClick={saveTodaysRun}
                          disabled={todaysRunSaving}
                          className="inline-flex items-center justify-center gap-2 rounded-lg bg-purple-500 hover:bg-purple-400 disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold text-xs px-4 py-1.5 transition-colors w-full"
                        >
                          {todaysRunSaving ? <><Spinner />Saving…</> : todaysRunSaved ? "Saved to Today's Run!" : "Save to Today's Running Playlist"}
                        </button>
                      )}
                      {todaysRunError && <p className="text-xs text-red-400">{todaysRunError}</p>}
                      {todaysRunSaved && todaysRunUrl && (
                        <a
                          href={todaysRunUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-purple-300 hover:text-purple-200 underline"
                        >
                          Open &quot;{TODAYS_RUN_PLAYLIST}&quot; ↗
                        </a>
                      )}
                      </div>
                    </div>
                  )}
                </div>

                {saveError && (
                  <div className="px-5 py-3 text-sm text-red-400 border-b border-slate-800">
                    {saveError}
                  </div>
                )}


                {step === "partial" && savedUrl && (
                  <div className="px-5 py-4 border-b border-slate-800 space-y-3">
                    <div className="flex items-start gap-3">
                      <span className="text-yellow-400 text-lg leading-none">⚠</span>
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-yellow-400">Playlist created, but tracks couldn&apos;t be added automatically</p>
                        <p className="text-xs text-slate-400">
                          Spotify restricts track modifications for new apps. The empty playlist is ready in your library — add the tracks manually using the URIs below.
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <a
                        href={savedUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 rounded-lg bg-green-500/10 border border-green-500/30 text-green-400 text-xs font-semibold px-3 py-1.5 hover:bg-green-500/20 transition-colors"
                      >
                        Open empty playlist ↗
                      </a>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(pendingUris.join("\n")).then(() => {
                            setCopied(true);
                            setTimeout(() => setCopied(false), 2000);
                          });
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-semibold px-3 py-1.5 transition-colors"
                      >
                        {copied ? "Copied!" : `Copy ${pendingUris.length} track URIs`}
                      </button>
                    </div>
                    <p className="text-xs text-slate-500">
                      To add tracks: open Spotify desktop → open the playlist → search for each song and right-click → &quot;Add to playlist&quot;.
                      Or paste the URIs into{" "}
                      <a href="https://soundiiz.com" target="_blank" rel="noopener noreferrer" className="text-slate-400 underline hover:text-slate-300">soundiiz.com</a>
                      {" "}to import in bulk.
                    </p>
                  </div>
                )}

                {filteredTracks.length === 0 ? (
                  <div className="p-8 text-center text-slate-500 text-sm">
                    {noBpmFilter ? "All tracks have BPM info 🎉" : aiDjMix ? (remixing ? "Rebuilding mix…" : "No tracks in this mix.") : "No tracks in this BPM range. Try a different zone."}
                  </div>
                ) : (
                  <VirtualTrackList
                    key={aiDjMix ? `aidj-${aiDjMix.name}` : noBpmFilter ? "nobpm" : similarFilter ? `sim-${similarFilter.seed.id}` : paceFilter ? `pace-${paceFilter.paces.map(p=>p.bpm).join("-")}` : selectedZones.map(z=>z.number).sort().join("-")}
                    tracks={filteredTracks}
                    onDelete={handleDeleteTrack}
                    onSimilar={handleSimilar}
                    onSuggest={handleSuggest}
                    suggestBusy={suggest && suggest.results === null && !suggest.error
                      ? { trackId: suggest.seed.id, mode: suggest.mode }
                      : null}
                    inlineCard={suggest && suggestSeedVisible
                      ? { trackId: suggest.seed.id, node: suggestCardNode }
                      : null}
                  />
                )}
              </div>
            )}

            {/* Song suggestions (AI_BPM Phase B) — standalone fallback when the
                seed row isn't visible anywhere (rendered inline below the seed
                row in the track list or BBC card otherwise) */}
            {suggest && suggest.origin === "list" && !suggestSeedVisible && suggestCardNode}

            {/* BPM distribution */}
            {allTracks.length > 0 && selectedZones.length > 0 && (
              <BPMDistribution tracks={allTracks} zones={displayZones} selectedZones={selectedZones} />
            )}

            {/* No CSV loaded */}
            {!csvName && (
              <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5 text-center space-y-2">
                <p className="text-sm text-slate-400">No playlist loaded.</p>
                <Link href="/settings" className="text-xs text-green-400 hover:text-green-300 underline transition-colors">
                  Upload your Running.csv in Settings →
                </Link>
              </div>
            )}

            {/* BBC Programme Cards */}
            {bbcProgrammes.map(p => (
              <BbcPlaylistCard
                key={p.pid}
                pid={p.pid}
                defaultName={p.name}
                synopsis={p.synopsis}
                onRemove={() => handleRemoveBbcProgramme(p.pid)}
                editHref={`/settings?bbc=replace&pid=${p.pid}&name=${encodeURIComponent(p.name)}`}
                onSimilar={t => handleSimilar(bbcToTrack(t))}
                onSuggest={(t, mode) => handleSuggest(bbcToTrack(t), mode, "bbc")}
                suggestBusy={suggest && suggest.results === null && !suggest.error
                  ? { trackId: suggest.seed.id, mode: suggest.mode }
                  : null}
                inlineCard={suggest && suggest.origin === "bbc"
                  ? { trackId: suggest.seed.id, node: suggestCardNode }
                  : null}
              />
            ))}
            {/* Add BBC Programme card */}
            <Link
              href="/settings?bbc=add"
              className="flex items-center justify-center gap-2 rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 border-dashed p-5 text-slate-500 hover:text-slate-300 hover:border-white/20 transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
              </svg>
              <span className="text-sm font-medium">Add BBC Programme</span>
            </Link>

          </main>

          {/* Col 3: Right rail — Runna */}
          <div className="space-y-6 min-w-0">
            <RunnaSummaryCard />
            <RunnaScheduleCard
              aiDjEnabled={aiDjEnabled}
              garminConfigured={garminConfigured}
              activePaces={paceFilter?.paces.map(p => p.paceStr) ?? []}
              onAiDjMix={handleAiDjMix}
              onPaceFilter={(paceStr, bpm, multiSelect) => {
                setNoBpmFilter(false);
                setAiDjMix(null);
                if (multiSelect) {
                  setPaceFilter(prev => {
                    const current = prev?.paces ?? [];
                    const exists = current.some(p => p.paceStr === paceStr);
                    const next = exists ? current.filter(p => p.paceStr !== paceStr) : [...current, { paceStr, bpm }];
                    if (next.length === 0) return null;
                    const sorted = [...next].sort((a, b) => a.bpm - b.bpm);
                    if (csvName) setPlaylistName(`${csvName} – ${sorted.map(p => p.paceStr).join(", ")}/mi`);
                    return { paces: next };
                  });
                } else {
                  setPaceFilter({ paces: [{ paceStr, bpm }] });
                  setSelectedZones([]);
                  if (csvName) setPlaylistName(`${csvName} – ${paceStr}/mi`);
                }
              }}
            />
          </div>

        </div>
      </div>

      {similarLoading && (
        <div className="fixed bottom-6 right-6 z-20 flex items-center gap-2 rounded-lg bg-slate-800 border border-white/10 px-4 py-2.5 text-sm text-slate-300 shadow-xl">
          <Spinner /> Finding similar songs…
        </div>
      )}
      {similarNotice && !similarLoading && (
        <div className="fixed bottom-6 right-6 z-20 rounded-lg bg-slate-800 border border-red-500/30 px-4 py-2.5 text-sm text-red-400 shadow-xl">
          {similarNotice}
        </div>
      )}

    </div>
  );
}

function SuggestionsCard({ suggest, onClose, onAdd }: {
  suggest: SuggestState;
  onClose: () => void;
  onAdd: (items: Suggestion[]) => Promise<void>;
}) {
  const { data: session } = useSession();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [added, setAdded]       = useState<Set<number>>(new Set());
  const [adding, setAdding]     = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const results = suggest.results;

  function toggle(i: number) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  }

  async function addSelected() {
    if (!results || selected.size === 0) return;
    setAdding(true);
    setAddError(null);
    try {
      const items = Array.from(selected).map(i => results[i]);
      await onAdd(items);
      setAdded(prev => {
        const next = new Set(prev);
        selected.forEach(i => next.add(i));
        return next;
      });
      setSelected(new Set());
    } catch (e) {
      setAddError(e instanceof Error ? e.message : "Failed to add tracks");
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="rounded-xl bg-slate-900/95 backdrop-blur-sm border border-white/10 overflow-hidden">
      <div className="p-5 border-b border-white/10 flex items-start justify-between gap-4">
        <div>
          <h3 className="font-semibold flex items-center gap-2">
            <span className={suggest.mode === "style" ? "text-purple-400" : "text-orange-400"}>
              {suggest.mode === "style" ? "✦" : "♩"}
            </span>
            New songs like &quot;{suggest.seed.name}&quot;
            <span className="text-xs font-normal text-slate-500">
              ({suggest.mode === "style" ? "similar style" : "similar tempo"} · {suggest.seed.bpm} BPM seed)
            </span>
          </h3>
          <p className="text-sm text-slate-500 mt-0.5">
            {suggest.seed.artists[0]?.name} — via Last.fm similarity, not in your playlist
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {results !== null && results.length > 0 && (
            <button
              onClick={addSelected}
              disabled={selected.size === 0 || adding}
              className="inline-flex items-center gap-2 rounded-lg bg-green-500 hover:bg-green-400 disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold text-xs px-3 py-1.5 transition-colors"
            >
              {adding ? <><Spinner />Adding…</> : `Add ${selected.size || ""} to playlist`}
            </button>
          )}
          <button
            onClick={onClose}
            className="text-slate-600 hover:text-slate-300 text-lg leading-none transition-colors"
            title="Close"
          >
            ×
          </button>
        </div>
      </div>

      {addError && (
        <p className="px-5 py-3 text-sm text-red-400 border-b border-slate-800">{addError}</p>
      )}

      {suggest.error && (
        <p className="px-5 py-4 text-sm text-red-400">{suggest.error}</p>
      )}

      {!suggest.error && results === null && (
        <div className="px-5 py-6 flex items-center gap-3">
          <Spinner />
          <div>
            <p className="text-sm text-slate-300">Searching Last.fm → Deezer → ReccoBeats… this takes a minute or two.</p>
            <p className="text-xs text-slate-500 mt-1 font-mono">{suggest.progress}</p>
          </div>
        </div>
      )}

      {results !== null && results.length === 0 && (
        <p className="px-5 py-4 text-sm text-slate-500">No new songs found for this seed.</p>
      )}

      {results !== null && results.length > 0 && (
        <div className="divide-y divide-slate-800/50 max-h-[600px] overflow-y-auto no-scrollbar">
          {results.map((s, i) => {
            const isAdded = added.has(i);
            const canAdd = spotifyIdFromUrl(s.spotifyUrl) !== null && !isAdded;
            return (
              <div key={`${s.artist}-${s.name}`} className="flex items-center group/sug">
                <label
                  className={`pl-3 pr-1 py-2 shrink-0 ${canAdd ? "cursor-pointer" : "cursor-default"}`}
                  title={isAdded ? "Added" : canAdd ? "Select to add to playlist" : "No Spotify ID — can't add automatically"}
                >
                  {isAdded ? (
                    <span className="w-4 h-4 flex items-center justify-center text-green-400 text-sm">✓</span>
                  ) : (
                    <input
                      type="checkbox"
                      checked={selected.has(i)}
                      disabled={!canAdd}
                      onChange={() => toggle(i)}
                      className="w-4 h-4 rounded accent-green-500 disabled:opacity-30"
                    />
                  )}
                </label>
                <button
                  onClick={() => {
                    const id = spotifyIdFromUrl(s.spotifyUrl);
                    if (id) playInSpotify(`spotify:track:${id}`, session?.accessToken).catch(() => {});
                    else window.open(`https://open.spotify.com/search/${encodeURIComponent(`${s.artist} ${s.name}`)}`, "_blank");
                  }}
                  className="flex-1 flex items-center gap-3 px-2 py-2 hover:bg-slate-800/60 transition-colors min-w-0 text-left"
                >
                  <div className="h-9 w-9 rounded shrink-0 overflow-hidden bg-slate-800">
                    <img
                      src={`/api/itunes-art?artist=${encodeURIComponent(s.artist)}&title=${encodeURIComponent(s.name)}`}
                      alt=""
                      className="h-full w-full object-cover"
                      onError={e => { (e.target as HTMLImageElement).style.display = "none"; }}
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate group-hover/sug:text-green-400 transition-colors">{s.name}</p>
                    <p className="text-xs text-slate-500 truncate">{s.artist}</p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-xs text-slate-600 font-mono">{s.camelot}</span>
                    <span className="text-xs font-mono font-semibold text-green-400 bg-green-500/10 rounded px-1.5 py-0.5">
                      {s.bpm} BPM
                    </span>
                    <span className="text-slate-700 group-hover/sug:text-green-500 text-xs">↗</span>
                  </div>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function BPMDistribution({
  tracks, zones, selectedZones,
}: {
  tracks: TrackWithBPM[];
  zones: RunningZone[];
  selectedZones: RunningZone[];
}) {
  const counts = zones.map(z => filterTracksByBPM(tracks, z.bpmMin, z.bpmMax).length);
  // Tracks that fall in no zone at all (mostly sub-Z1 tempos) — zones overlap,
  // so the zone bars alone don't account for the whole playlist.
  const outside = tracks.filter(
    t => !zones.some(z => t.bpm >= z.bpmMin - 3 && t.bpm <= z.bpmMax + 3),
  ).length;
  const max = Math.max(...counts, outside, 1);
  const isAll = selectedZones.some(z => z.number === 0);
  return (
    <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5">
      <h3 className="text-sm font-semibold mb-4 text-slate-400">
        BPM distribution across zones
        <span className="font-normal text-slate-600"> — zones overlap, so bars can share tracks</span>
      </h3>
      <div className="flex items-end gap-2 h-20">
        {zones.map((z, i) => {
          const active = isAll || selectedZones.some(s => s.number === z.number);
          return (
            <div key={z.number} className="flex-1 flex flex-col items-center gap-1">
              <span className={`text-xs font-mono ${active ? "text-white font-bold" : "text-slate-500"}`}>
                {counts[i]}
              </span>
              <div className="w-full rounded-t" style={{ height: `${Math.max((counts[i] / max) * 56, 4)}px` }}>
                <div className={`w-full h-full rounded-t ${z.color} ${active ? "opacity-100" : "opacity-30"}`} />
              </div>
              <span className="text-xs text-slate-600">Z{z.number}</span>
            </div>
          );
        })}
        <div
          className="flex-1 flex flex-col items-center gap-1"
          title={`${outside} tracks outside every zone's BPM range (below Z1 or above Z5)`}
        >
          <span className={`text-xs font-mono ${isAll ? "text-white font-bold" : "text-slate-500"}`}>{outside}</span>
          <div className="w-full rounded-t" style={{ height: `${Math.max((outside / max) * 56, 4)}px` }}>
            <div className={`w-full h-full rounded-t bg-slate-600 ${isAll ? "opacity-100" : "opacity-30"}`} />
          </div>
          <span className="text-xs text-slate-600">Out</span>
        </div>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

