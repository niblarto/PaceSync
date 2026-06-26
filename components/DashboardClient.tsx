"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { signOut, useSession } from "next-auth/react";
import Link from "next/link";
import type { RunningZone, TrackWithBPM } from "@/types";
import { ZoneCard } from "./ZoneCard";
import { TrackRow } from "./TrackRow";
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

function VirtualTrackList({ tracks, onDelete }: { tracks: TrackWithBPM[]; onDelete?: (track: TrackWithBPM) => void }) {
  const [visibleCount, setVisibleCount] = useState(50);
  const containerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

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
    <div ref={containerRef} className="divide-y divide-slate-800/50 max-h-[600px] overflow-y-auto">
      {tracks.slice(0, visibleCount).map((track, i) => (
        <TrackRow
          key={track.id}
          track={track}
          index={i}
          onDelete={onDelete ? () => onDelete(track) : undefined}
        />
      ))}
      {visibleCount < tracks.length && (
        <div ref={sentinelRef} className="py-2 text-center text-xs text-slate-600">
          {visibleCount} of {tracks.length}
        </div>
      )}
    </div>
  );
}

const RUNNING_PLAYLIST_ID = process.env.NEXT_PUBLIC_RUNNING_PLAYLIST_ID ?? "";

const BBC_DEFAULTS = [
  { pid: "m001j52w", name: "6 Music Playlist", synopsis: "" },
  { pid: "m0012v02", name: "6 Music's Indie Forever", synopsis: "" },
  { pid: "m002xsbn", name: "Lauren Laverne", synopsis: "" },
];

interface Props {
  spotifyUser: { name: string; image: string | null };
}

type Step = "idle" | "ready" | "saving" | "saved" | "partial";

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
  const [selectedZone, setSelectedZone] = useState<RunningZone | null>(null);
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
        prewarmArt(result.tracks);
      })
      .catch(() => {/* silently ignore if file missing */});
  }, []);

  // Re-filter whenever zone or tracks change
  useEffect(() => {
    if (allTracks.length > 0 && selectedZone) {
      const filtered = selectedZone.number === 0
        ? allTracks
        : filterTracksByBPM(allTracks, selectedZone.bpmMin, selectedZone.bpmMax);
      setFilteredTracks(filtered);
    }
  }, [selectedZone, allTracks]);

  async function handleDeleteTrack(track: TrackWithBPM) {
    const token = session?.accessToken;

    // Optimistically remove from local state immediately
    setAllTracks(prev => prev.filter(t => t.id !== track.id));

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
          description: `PaceSync: ${selectedZone?.name} zone (${selectedZone?.bpmMin}–${selectedZone?.bpmMax} BPM)`,
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
            <Link
              href="/settings"
              className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
            >
              Settings
            </Link>
            <button
              onClick={() => signOut({ callbackUrl: "/" })}
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
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">Heart Rate Zones</h2>
              <Link
                href="/settings"
                className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
              >
                Edit zones →
              </Link>
            </div>

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
                  setSelectedZone(ALL_ZONE);
                  if (csvName) setPlaylistName(csvName);
                }}
                className={`w-full rounded-lg border p-4 text-left transition-all ${
                  selectedZone?.number === 0
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
              </button>

              {displayZones.map((zone) => (
                <ZoneCard
                  key={zone.number}
                  zone={zone}
                  selected={selectedZone?.number === zone.number}
                  onClick={() => {
                    setSelectedZone(zone);
                    if (csvName) setPlaylistName(`${csvName} – ${zone.name}`);
                  }}
                />
              ))}
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
                  {selectedZone ? (
                    <span className="text-green-400 font-medium">
                      Zone {selectedZone.number} — {selectedZone.name} · ♪ {selectedZone.bpmMin}–{selectedZone.bpmMax} BPM music
                    </span>
                  ) : (
                    <span className="text-slate-500">← Select a zone on the left</span>
                  )}
                </div>
              </div>
            )}

            {/* Results */}
            {step !== "idle" && csvName && selectedZone && (
              <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 overflow-hidden">
                <div className="p-5 border-b border-white/10 flex items-start justify-between gap-4 flex-wrap">
                  <div>
                    <h3 className="font-semibold">
                      {filteredTracks.length} tracks in zone {selectedZone.number} ({selectedZone.bpmMin}–{selectedZone.bpmMax} BPM)
                    </h3>
                    <p className="text-sm text-slate-500 mt-0.5">
                      From {allTracks.length} total tracks in "{csvName}"
                    </p>
                  </div>

                  {filteredTracks.length > 0 && step !== "partial" && (
                    <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
                      <input
                        type="text"
                        value={playlistName}
                        onChange={(e) => setPlaylistName(e.target.value)}
                        placeholder="Playlist name"
                        className="rounded-lg bg-slate-800 border border-slate-700 text-sm px-3 py-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-green-500 w-48"
                      />
                      <button
                        onClick={savePlaylist}
                        disabled={!playlistName || step === "saving"}
                        className="inline-flex items-center gap-2 rounded-lg bg-green-500 hover:bg-green-400 disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold text-sm px-4 py-2 transition-colors whitespace-nowrap"
                      >
                        {step === "saving" ? <><Spinner />Saving…</> : "Save to Spotify"}
                      </button>
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
                    No tracks in this BPM range. Try a different zone.
                  </div>
                ) : (
                  <VirtualTrackList key={selectedZone?.number} tracks={filteredTracks} onDelete={handleDeleteTrack} />
                )}
              </div>
            )}

            {/* BPM distribution */}
            {allTracks.length > 0 && selectedZone && (
              <BPMDistribution tracks={allTracks} zones={displayZones} selectedZone={selectedZone} />
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
            <RunnaScheduleCard />
          </div>

        </div>
      </div>

    </div>
  );
}

function BPMDistribution({
  tracks, zones, selectedZone,
}: {
  tracks: TrackWithBPM[];
  zones: RunningZone[];
  selectedZone: RunningZone | null;
}) {
  const counts = zones.map(z => filterTracksByBPM(tracks, z.bpmMin, z.bpmMax).length);
  const max = Math.max(...counts, 1);
  return (
    <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5">
      <h3 className="text-sm font-semibold mb-4 text-slate-400">BPM distribution across zones</h3>
      <div className="flex items-end gap-2 h-20">
        {zones.map((z, i) => (
          <div key={z.number} className="flex-1 flex flex-col items-center gap-1">
            <span className={`text-xs font-mono ${selectedZone?.number === z.number ? "text-white font-bold" : "text-slate-500"}`}>
              {counts[i]}
            </span>
            <div className="w-full rounded-t" style={{ height: `${Math.max((counts[i] / max) * 56, 4)}px` }}>
              <div className={`w-full h-full rounded-t ${z.color} ${selectedZone?.number === z.number ? "opacity-100" : "opacity-30"}`} />
            </div>
            <span className="text-xs text-slate-600">Z{z.number}</span>
          </div>
        ))}
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

