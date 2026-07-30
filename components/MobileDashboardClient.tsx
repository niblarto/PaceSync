"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { signOut, useSession } from "next-auth/react";
import type { TrackWithBPM } from "@/types";
import { freshSpotifyToken, spotifyFetch } from "@/lib/spotify-browser";
import { SpotifyRateLimitBanner } from "./SpotifyRateLimitBanner";
import { MissingDataBanner } from "./MissingDataBanner";
import { TrackRow } from "./TrackRow";
import { RunnaSummaryCard, RunnaScheduleCard, type AiDjTimeline, type RunnaScheduleHandle } from "./RunnaCard";
import { MixPaceChart, timelineToChartTracks } from "./MixPaceChart";
import { useRunningPlaylist } from "./useRunningPlaylist";

// Mobile-only dashboard — a deliberately separate, smaller component from
// DashboardClient.tsx (not a shared/extracted piece of it). DashboardClient's
// track list, filters, CSV loading, and save flow are all private internals
// of one large component with nothing exported to reuse, so this reimplements
// just the "core" subset for a phone: track list + zone/search filtering +
// AI DJ mix build/review, as two full-screen tabs instead of three desktop
// columns. CSV upload, suggestions (style/tempo/artist), bulk ops, and
// plain-browsing "Save to Spotify" are intentionally left desktop-only.

interface Props {
  spotifyUser: { name: string; image: string | null };
}

const FALLBACK_AVATAR = "data:image/svg+xml;utf8," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#64748b">
     <rect width="24" height="24" rx="12" fill="#1e293b"/>
     <path fill-rule="evenodd" d="M18.685 19.097A9.723 9.723 0 0021.75 12c0-5.385-4.365-9.75-9.75-9.75S2.25 6.615 2.25 12a9.723 9.723 0 003.065 7.097A9.716 9.716 0 0012 21.75a9.716 9.716 0 006.685-2.653zm-12.54-1.285A7.486 7.486 0 0112 15a7.486 7.486 0 015.855 2.812A8.224 8.224 0 0112 20.25a8.224 8.224 0 01-5.855-2.438zM15.75 9a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" clip-rule="evenodd"/>
   </svg>`
);

// Quote-aware CSV row parser — same logic DashboardClient.tsx keeps privately;
// duplicated here rather than imported since nothing in that file is exported.
function parseCsvRow(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { current += '"'; i++; } else { inQuotes = false; }
      } else current += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      result.push(current);
      current = "";
    } else current += c;
  }
  result.push(current);
  return result;
}

function parseExportifyCsv(text: string): TrackWithBPM[] {
  const stripped = text.charCodeAt(0) === 65279 ? text.slice(1) : text;
  const cleaned = stripped.replace(/\r/g, "");
  const lines = cleaned.split("\n").filter(Boolean);
  if (lines.length < 2) return [];

  const headers = parseCsvRow(lines[0]);
  const col = (...names: string[]) =>
    headers.findIndex(h => names.some(n => h.trim().toLowerCase() === n.toLowerCase()));

  const idxId = col("Track URI", "Spotify URI", "Spotify ID", "uri", "id");
  const idxUrl = col("Spotify URL", "Spotify Url", "URL", "Url");
  const idxName = col("Track Name", "Name", "Song", "Title");
  const idxArtist = col("Artist Name(s)", "Artist", "Artists");
  const idxAlbum = col("Album Name", "Album");
  const idxDuration = col("Track Duration (ms)", "Duration (ms)", "Duration");
  const idxBpm = col("BPM", "Tempo", "bpm", "tempo");
  const idxEnergy = col("Energy", "energy");
  if ((idxId === -1 && idxUrl === -1) || idxName === -1) return [];

  const hasBpm = idxBpm !== -1;
  const tracks: TrackWithBPM[] = [];
  for (let i = 1; i < lines.length; i++) {
    const row = parseCsvRow(lines[i]);
    let raw = (idxId !== -1 ? row[idxId]?.trim() : "") ?? "";
    if (!raw && idxUrl !== -1) {
      const urlMatch = row[idxUrl]?.match(/track[/:]([A-Za-z0-9]+)/);
      raw = urlMatch ? urlMatch[1] : "";
    }
    const id = raw.startsWith("spotify:track:") ? raw.slice("spotify:track:".length) : raw;
    if (!id) continue;
    const bpm = hasBpm ? parseFloat(row[idxBpm]) : 0;
    tracks.push({
      id,
      name: row[idxName] ?? "Unknown",
      artists: [{ name: row[idxArtist] ?? "Unknown" }],
      album: { name: row[idxAlbum] ?? "", images: [] },
      duration_ms: parseInt(row[idxDuration] ?? "0") || 0,
      uri: id.startsWith("spotify:") ? id : `spotify:track:${id}`,
      bpm: hasBpm && !isNaN(bpm) && bpm > 0 ? Math.round(bpm) : 0,
      energy: parseFloat(row[idxEnergy] ?? "0") || 0,
    });
  }
  return tracks;
}

interface AiDjMixState {
  workoutTitle: string;
  name: string;
  tracks: TrackWithBPM[];
  totalSec: number;
  segments: string[];
  date: string;
  timeline: AiDjTimeline;
  avoidUris?: string[];
  originalCount: number;
}

type Tab = "tracks" | "runna";

export function MobileDashboardClient({ spotifyUser }: Props) {
  const { data: session } = useSession();
  const { id: RUNNING_PLAYLIST_ID } = useRunningPlaylist();
  const scheduleRef = useRef<RunnaScheduleHandle>(null);

  const [tab, setTab] = useState<Tab>("runna");
  const [allTracks, setAllTracks] = useState<TrackWithBPM[]>([]);
  const [csvLoaded, setCsvLoaded] = useState(false);
  const [garminConfigured, setGarminConfigured] = useState(false);
  const [aiDjEnabled, setAiDjEnabled] = useState(false);
  const [playedCounts, setPlayedCounts] = useState<Record<string, number>>({});

  const [searchText, setSearchText] = useState("");
  const [aiDjMix, setAiDjMix] = useState<AiDjMixState | null>(null);
  const [remixing, setRemixing] = useState(false);
  const [toppingUp, setToppingUp] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pinSaving, setPinSaving] = useState(false);
  const [pinSaved, setPinSaved] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/playlist-csv")
      .then(r => { if (!r.ok) throw new Error("no csv"); return r.text(); })
      .then(text => { setAllTracks(parseExportifyCsv(text)); setCsvLoaded(true); })
      .catch(() => setCsvLoaded(true));
  }, []);

  useEffect(() => {
    fetch("/api/settings/garmin")
      .then(r => r.json())
      .then((d: { configured?: boolean }) => setGarminConfigured(d.configured ?? false))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/settings/ai-dj")
      .then(r => r.json())
      .then((d: { enabled?: boolean }) => setAiDjEnabled(d.enabled ?? false))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/tracks/played-counts")
      .then(r => r.json())
      .then((d: { counts?: Record<string, number> }) => setPlayedCounts(d.counts ?? {}))
      .catch(() => {});
  }, []);

  // Mix build finishes on the Runna tab (RunnaScheduleCard does the actual
  // work) — jump to the Tracks tab so it can be reviewed/saved/remixed, per
  // the requested cross-tab behavior.
  function handleAiDjMix(
    workoutTitle: string, name: string, tracks: TrackWithBPM[], totalSec: number,
    segments: string[], date: string, timeline: AiDjTimeline, avoidUris?: string[],
  ) {
    const unique = tracks.filter((t, i, a) => a.findIndex(x => x.uri === t.uri) === i);
    setAiDjMix({ workoutTitle, name, tracks: unique, totalSec, segments, date, timeline, avoidUris, originalCount: unique.length });
    setSaved(false);
    setSaveError(null);
    setPinSaved(false);
    setPinError(null);
    setTab("tracks");
  }

  const displayedTracks: TrackWithBPM[] = aiDjMix
    ? aiDjMix.tracks
    : searchText.trim()
      ? allTracks.filter(t => {
          const q = searchText.trim().toLowerCase();
          return t.name.toLowerCase().includes(q) || t.artists.some(a => a.name.toLowerCase().includes(q));
        })
      : allTracks;

  async function handleDeleteTrack(track: TrackWithBPM) {
    const token = await freshSpotifyToken();
    setAllTracks(prev => prev.filter(t => t.id !== track.id));
    setAiDjMix(prev => (prev ? { ...prev, tracks: prev.tracks.filter(t => t.id !== track.id) } : prev));

    const fullUri = track.uri.startsWith("spotify:") ? track.uri : `spotify:track:${track.uri}`;
    if (token) {
      spotifyFetch(`https://api.spotify.com/v1/playlists/${RUNNING_PLAYLIST_ID}/items`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ uri: fullUri }] }),
      }).catch(() => {});
    }
    fetch("/api/tracks/delete", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spotifyUri: fullUri }),
    }).catch(() => {});
  }

  async function addTracksBrowser(playlistId: string, uris: string[]): Promise<void> {
    const token = await freshSpotifyToken();
    if (!token) throw new Error("No access token");
    for (let i = 0; i < uris.length; i += 100) {
      const res = await spotifyFetch(`https://api.spotify.com/v1/playlists/${playlistId}/items`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ uris: uris.slice(i, i + 100) }),
      });
      if (!res.ok) throw new Error(`Spotify ${res.status}: ${await res.text()}`);
    }
  }

  async function saveMix() {
    if (!aiDjMix || !aiDjMix.tracks.length) return;
    // See DashboardClient.saveTodaysRun's comment — aiDjMix.date is set once
    // when the mix was built/loaded and never refreshed, so a stale mix left
    // over from an earlier day (Runna reuses workout titles week to week)
    // would otherwise silently save under that old date instead of today's.
    const today = new Date().toISOString().slice(0, 10);
    if (aiDjMix.date !== today) {
      const [y, m, d] = aiDjMix.date.split("-");
      const proceed = window.confirm(
        `This mix was built for ${d}-${m}-${y} ("${aiDjMix.workoutTitle}"), not today — save it as today's run anyway?`
      );
      if (!proceed) return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/spotify/create-playlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Today's Run",
          description: `${aiDjMix.workoutTitle} - ${aiDjMix.date.split("-").reverse().join("-")}`,
          trackUris: aiDjMix.tracks.map(t => t.uri),
        }),
      });
      const data = await res.json() as { error?: string; url?: string; tracksAdded?: boolean; trackUris?: string[] };
      if (data.error) throw new Error(data.error);
      if (data.tracksAdded === false && data.url) {
        const playlistId = data.url.split("/").pop()!;
        await addTracksBrowser(playlistId, data.trackUris ?? aiDjMix.tracks.map(t => t.uri));
      }
      await fetch("/api/todays-run/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: aiDjMix.date,
          workoutTitle: aiDjMix.workoutTitle,
          timeline: aiDjMix.timeline,
        }),
      }).catch(() => {});
      setSaved(true);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Failed to save playlist");
    } finally {
      setSaving(false);
    }
  }

  async function pinMixToWorkout() {
    if (!aiDjMix?.timeline?.length) return;
    setPinSaving(true);
    setPinError(null);
    try {
      const res = await fetch("/api/ai-dj/pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: aiDjMix.date,
          workoutTitle: aiDjMix.workoutTitle,
          totalSec: aiDjMix.totalSec,
          timeline: aiDjMix.timeline,
        }),
      });
      const d = await res.json() as { error?: string };
      if (!res.ok) throw new Error(d.error ?? "Pin failed");
      setPinSaved(true);
    } catch (e) {
      setPinError(e instanceof Error ? e.message : "Pin failed");
    } finally {
      setPinSaving(false);
    }
  }

  async function remix() {
    if (!aiDjMix || !scheduleRef.current) return;
    setRemixing(true);
    const priorUris = aiDjMix.tracks.map(t => t.uri);
    const avoidUris = Array.from(new Set([...(aiDjMix.avoidUris ?? []), ...priorUris]));
    setAiDjMix(prev => (prev ? { ...prev, tracks: [] } : prev));
    try {
      await scheduleRef.current.remix(aiDjMix.date, avoidUris);
    } finally {
      setRemixing(false);
    }
  }

  async function fillGap() {
    if (!aiDjMix || !scheduleRef.current) return;
    const gap = aiDjMix.originalCount - aiDjMix.tracks.length;
    if (gap <= 0) return;
    setToppingUp(true);
    const keptUris = aiDjMix.tracks.map(t => t.uri);
    const avoidUris = Array.from(new Set([...(aiDjMix.avoidUris ?? []), ...keptUris]));
    try {
      await scheduleRef.current.topUp(aiDjMix.date, avoidUris, (tracks, totalSec, timeline) => {
        setAiDjMix(prev => (prev ? { ...prev, tracks, totalSec, timeline } : prev));
      });
    } finally {
      setToppingUp(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100">
      <header className="border-b border-white/5 bg-slate-950/70 backdrop-blur-md sticky top-0 z-20">
        <div className="px-2 h-14 flex items-center justify-between">
          <span className="font-bold text-green-400 text-lg tracking-tight">PaceSync</span>
          <div className="flex items-center gap-3">
            {spotifyUser.image && (
              <img
                src={spotifyUser.image}
                alt=""
                className="h-7 w-7 rounded-full"
                onError={e => { (e.target as HTMLImageElement).src = FALLBACK_AVATAR; }}
              />
            )}
            <button
              onClick={() => signOut({ callbackUrl: "/" })}
              className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <SpotifyRateLimitBanner />
      <MissingDataBanner />

      <div className="flex-1 flex flex-col min-h-0">
        <div className={tab === "tracks" ? "flex-1 min-h-0 flex flex-col" : "hidden"}>
          {aiDjMix && (
            <div className="p-2 border-b border-white/10 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="font-semibold text-sm truncate">{aiDjMix.workoutTitle}</h2>
                  <p className="text-xs text-slate-500">{aiDjMix.tracks.length} tracks</p>
                </div>
                <button
                  onClick={() => setAiDjMix(null)}
                  className="shrink-0 text-xs text-slate-500 hover:text-slate-300 border border-white/10 rounded-lg px-2.5 py-1"
                >
                  Close mix
                </button>
              </div>
              {aiDjMix.timeline?.length > 0 && (
                <MixPaceChart tracks={timelineToChartTracks(aiDjMix.timeline)} />
              )}
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  onClick={saveMix}
                  disabled={saving}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-green-500 hover:bg-green-400 disabled:opacity-40 text-black font-semibold text-xs px-2.5 py-2 transition-colors"
                >
                  {saving ? "Saving…" : saved ? "Saved!" : "Save"}
                </button>
                <button
                  onClick={remix}
                  disabled={remixing || toppingUp}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-purple-500 hover:bg-purple-400 disabled:opacity-40 text-black font-semibold text-xs px-2.5 py-2 transition-colors"
                >
                  {remixing ? "Remixing…" : "🎧 Remix"}
                </button>
                {aiDjMix.tracks.length < aiDjMix.originalCount && (
                  <button
                    onClick={fillGap}
                    disabled={remixing || toppingUp}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-purple-500/40 bg-purple-500/15 hover:bg-purple-500/25 disabled:opacity-40 text-purple-300 font-semibold text-xs px-2.5 py-2 transition-colors"
                  >
                    {toppingUp ? "Filling gap…" : "Fill gap"}
                  </button>
                )}
                <button
                  onClick={pinMixToWorkout}
                  disabled={pinSaving || pinSaved}
                  title="The nightly pre-build will use this exact mix for the workout instead of generating a new one"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-purple-500/40 bg-purple-500/15 hover:bg-purple-500/25 disabled:opacity-60 text-purple-300 font-semibold text-xs px-2.5 py-2 transition-colors"
                >
                  {pinSaving ? "Pinning…" : pinSaved ? "📌 Pinned!" : "📌 Pin"}
                </button>
              </div>
              {saveError && <p className="text-xs text-red-400">{saveError}</p>}
              {pinError && <p className="text-xs text-red-400">{pinError}</p>}
            </div>
          )}

          {!aiDjMix && (
            <div className="p-2 border-b border-white/10 space-y-3">
              <div className="relative">
                <input
                  type="text"
                  value={searchText}
                  onChange={e => setSearchText(e.target.value)}
                  placeholder="Search track or artist…"
                  className="w-full rounded-lg bg-slate-800/60 border border-white/10 text-sm px-3 py-2 pr-7 text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-green-500"
                />
                {searchText && (
                  <button
                    onClick={() => setSearchText("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-200 text-sm leading-none"
                  >
                    ×
                  </button>
                )}
              </div>
              <p className="text-xs text-slate-500">
                {displayedTracks.length} of {allTracks.length} tracks
              </p>
            </div>
          )}

          <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar">
            {!csvLoaded ? (
              <div className="p-8 text-center text-slate-500 text-sm">Loading…</div>
            ) : displayedTracks.length === 0 ? (
              <div className="p-8 text-center text-slate-500 text-sm">No tracks found.</div>
            ) : (
              <div className="divide-y divide-slate-800/50">
                {displayedTracks.map((track, i) => (
                  <TrackRow
                    key={`${track.id}-${i}`}
                    track={track}
                    index={i}
                    onDelete={() => handleDeleteTrack(track)}
                    playedCount={playedCounts[track.uri]}
                    showStats={false}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        <div className={tab === "runna" ? "flex-1 min-h-0 overflow-y-auto no-scrollbar p-2 space-y-4" : "hidden"}>
          <RunnaSummaryCard />
          <RunnaScheduleCard
            ref={scheduleRef}
            garminConfigured={garminConfigured}
            aiDjEnabled={aiDjEnabled}
            onAiDjMix={handleAiDjMix}
            showRouteMaps={false}
          />
        </div>
      </div>

      <nav className="border-t border-white/10 bg-slate-950/90 backdrop-blur-md sticky bottom-0 z-20 flex">
        <button
          onClick={() => setTab("tracks")}
          className={`flex-1 py-3 text-sm font-medium transition-colors ${
            tab === "tracks" ? "text-green-400 border-t-2 border-green-400" : "text-slate-500"
          }`}
        >
          Tracks
        </button>
        <button
          onClick={() => setTab("runna")}
          className={`flex-1 py-3 text-sm font-medium transition-colors ${
            tab === "runna" ? "text-green-400 border-t-2 border-green-400" : "text-slate-500"
          }`}
        >
          Runna
        </button>
      </nav>
    </div>
  );
}
