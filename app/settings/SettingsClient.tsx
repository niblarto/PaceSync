"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useSession } from "next-auth/react";
import type { RunningZone } from "@/types";
import { BbcBrowserCard } from "@/components/BbcBrowserCard";
import { DedupCard } from "@/components/DedupCard";
import { invalidateRunningPlaylistCache } from "@/components/useRunningPlaylist";
import { freshSpotifyToken } from "@/lib/spotify-browser";
import { DeletedTracksReview, type RejectedTrack } from "@/components/DeletedTracksReview";
import { openInSpotify } from "@/components/TrackRow";

const ZONE_DETAILS = [
  {
    name: "Warm Up",
    color: "bg-emerald-500",
    colorText: "text-emerald-400",
    borderColor: "border-emerald-500/20",
    pct: "<60% of HRR",
    effort: "In this zone, you are working very easily, such as when walking.",
    feel: "You should feel very little effort in this zone and feel like you could carry on for hours if your legs were strong enough.",
  },
  {
    name: "Easy",
    color: "bg-green-500",
    colorText: "text-green-400",
    borderColor: "border-green-500/20",
    pct: "60–70% of HRR",
    effort: "In this zone, you are working easily and building aerobic base fitness. Much of your running will be in this zone.",
    feel: "A conversational effort — if you can say a sentence of about this length out loud while running without gasping for breath in the middle, you are good.",
  },
  {
    name: "Aerobic",
    color: "bg-yellow-500",
    colorText: "text-yellow-400",
    borderColor: "border-yellow-500/20",
    pct: "70–80% of HRR",
    effort: "In this zone, you are building general cardio fitness. This is where your marathon effort might be found for much of the race if you are finishing in under 5 hours.",
    feel: "This is a bit of an odd running zone — not optimal for developing either the anaerobic or aerobic energy systems. You probably won't spend much training time here, except building up to races at this effort. Beginners are the exception and can happily spend lots of time here.",
  },
  {
    name: "Threshold",
    color: "bg-orange-500",
    colorText: "text-orange-400",
    borderColor: "border-orange-500/20",
    pct: "80–90% of HRR",
    effort: "In this zone, you are working \"comfortably hard\". This is where your Tempo effort will be found (the pace you could sustain for ~1 hour), along with your Lactate Threshold.",
    feel: "If you are trying to do Lactate Threshold runs, they should be in zone 4. Find a hard effort level that doesn't quite bring on the burning sensation in the legs — slow down a little if you feel that.",
  },
  {
    name: "Maximum",
    color: "bg-red-500",
    colorText: "text-red-400",
    borderColor: "border-red-500/20",
    pct: "90–100% of HRR",
    effort: "In this zone, you are working very hard — this is where your Intervals effort will be found, along with 5K race effort (especially in the latter half), all the way up to your Max HR.",
    feel: "This will feel tough. Enjoy.",
  },
];

interface ZoneRow { min: number; max: number }

function calcZones(maxHR: number, restingHR: number): ZoneRow[] {
  const hrr = maxHR - restingHR;
  const pcts = [0.60, 0.70, 0.80, 0.90, 1.00];
  const tops = pcts.map(p => Math.round(restingHR + p * hrr));
  return [
    { min: 0,         max: tops[0] },
    { min: tops[0]+1, max: tops[1] },
    { min: tops[1]+1, max: tops[2] },
    { min: tops[2]+1, max: tops[3] },
    { min: tops[3]+1, max: maxHR   },
  ];
}

// %LTHR-based zones — same bands Garmin itself uses for a running "Based On
// LTHR" zone set (Z1 66-75%, Z2 75-82%, Z3 82-91%, Z4 91-99%, Z5 99-107%).
// Different basis from %HRR: no resting-HR term, and Z5's top is allowed to
// exceed LTHR itself (up to 107%) rather than being capped at Max HR.
function calcZonesFromLthr(lthr: number): ZoneRow[] {
  const bounds = [0.66, 0.75, 0.82, 0.91, 0.99, 1.07];
  const edges = bounds.map(p => Math.round(p * lthr));
  return [
    { min: edges[0],   max: edges[1] },
    { min: edges[1]+1, max: edges[2] },
    { min: edges[2]+1, max: edges[3] },
    { min: edges[3]+1, max: edges[4] },
    { min: edges[4]+1, max: edges[5] },
  ];
}

function zoneLabel(z: ZoneRow, i: number) {
  if (i === 0) return `< ${z.max} bpm`;
  return `${z.min} – ${z.max} bpm`;
}

interface BbcProgramme { pid: string; name: string; synopsis?: string }

interface SettingsClientProps {
  bbcMode?: "add" | "replace";
  bbcReplacePid?: string;
  bbcReplaceName?: string;
}

export function SettingsClient({ bbcMode, bbcReplacePid, bbcReplaceName }: SettingsClientProps = {}) {
  const router = useRouter();
  const { data: session } = useSession();

  // ── HR zone state ──────────────────────────────────────────────────────────
  const [maxHR, setMaxHR] = useState(166);
  const [restingHR, setRestingHR] = useState(39);
  const [lthr, setLthr] = useState(154);
  const [zones, setZones] = useState<ZoneRow[]>(calcZones(166, 39));
  const [zoneSource, setZoneSource] = useState<"manual" | "lthr" | "garmin" | "strava">("manual");
  const [zoneSourceLoading, setZoneSourceLoading] = useState(false);
  const [zoneSourceError, setZoneSourceError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── BBC state ──────────────────────────────────────────────────────────────
  const [bbcProgrammes, setBbcProgrammes] = useState<BbcProgramme[]>([]);
  const [bbcLoading, setBbcLoading] = useState(true);
  const [bbcBrowserOpen, setBbcBrowserOpen] = useState(false);
  const [bbcBrowserMode, setBbcBrowserMode] = useState<"add" | "replace">("add");
  const [bbcBrowserTargetPid, setBbcBrowserTargetPid] = useState<string | undefined>();
  const [bbcBrowserTargetName, setBbcBrowserTargetName] = useState<string | undefined>();
  const [bbcSaveMsg, setBbcSaveMsg] = useState<string | null>(null);

  // ── Runna URL state ────────────────────────────────────────────────────────
  const [runnaUrl, setRunnaUrl] = useState("");
  const [runnaSaving, setRunnaSaving] = useState(false);
  const [runnaSaved, setRunnaSaved] = useState(false);
  const [runnaError, setRunnaError] = useState<string | null>(null);

  // ── Strava state ───────────────────────────────────────────────────────────
  const [stravaClientId, setStravaClientId] = useState("");
  const [stravaClientSecret, setStravaClientSecret] = useState("");
  const [stravaHasSecret, setStravaHasSecret] = useState(false);
  const [stravaConnected, setStravaConnected] = useState(false);
  const [stravaAthleteName, setStravaAthleteName] = useState<string | null>(null);
  const [stravaSaving, setStravaSaving] = useState(false);
  const [stravaSaved, setStravaSaved] = useState(false);
  const [stravaError, setStravaError] = useState<string | null>(null);
  const [stravaWebhookSubscribed, setStravaWebhookSubscribed] = useState(false);
  const [stravaWebhookLoading, setStravaWebhookLoading] = useState(false);
  const [stravaWebhookError, setStravaWebhookError] = useState<string | null>(null);

  // ── Met Office weather state ───────────────────────────────────────────────
  const [metofficeKey, setMetofficeKey] = useState("");
  const [metofficePostcode, setMetofficePostcode] = useState("");
  const [metofficeHasKey, setMetofficeHasKey] = useState(false);
  const [metofficeSaving, setMetofficeSaving] = useState(false);
  const [metofficeSaved, setMetofficeSaved] = useState(false);
  const [metofficeError, setMetofficeError] = useState<string | null>(null);

  // ── ntfy state ─────────────────────────────────────────────────────────────
  const [ntfyTopic, setNtfyTopic] = useState("");
  const [ntfySaving, setNtfySaving] = useState(false);
  const [ntfySaved, setNtfySaved] = useState(false);
  const [ntfyError, setNtfyError] = useState<string | null>(null);
  const [ntfyTesting, setNtfyTesting] = useState(false);
  const [ntfyTestMsg, setNtfyTestMsg] = useState<string | null>(null);

  // ── AI DJ state ────────────────────────────────────────────────────────────
  const [aiDjUrl, setAiDjUrl] = useState("");
  const [aiDjEnabled, setAiDjEnabled] = useState(false);
  const [aiDjAutoPlaylist, setAiDjAutoPlaylist] = useState(true);
  const [aiDjSaving, setAiDjSaving] = useState(false);
  const [aiDjSaved, setAiDjSaved] = useState(false);
  const [aiDjError, setAiDjError] = useState<string | null>(null);
  const [aiDjHealth, setAiDjHealth] = useState<"idle" | "checking" | "ok" | "down">("idle");
  const [aiDjHealthLlm, setAiDjHealthLlm] = useState(false);
  const [aiDjHealthClaude, setAiDjHealthClaude] = useState(false);
  const [claudeKeyConfigured, setClaudeKeyConfigured] = useState(false);
  const [aiDjHealthMsg, setAiDjHealthMsg] = useState<string | null>(null);
  const [aiDjWolMac, setAiDjWolMac] = useState("");
  const [aiDjProvider, setAiDjProvider] = useState<"local" | "claude" | "gemini">("local");
  const [aiDjClaudeModel, setAiDjClaudeModel] = useState("claude-sonnet-5");
  const [aiDjClaudeEffort, setAiDjClaudeEffort] = useState("medium");
  const [aiDjGeminiModel, setAiDjGeminiModel] = useState("gemini-2.5-flash");
  const [claudeApiKey, setClaudeApiKey] = useState("");
  const [claudeKeySaving, setClaudeKeySaving] = useState(false);
  const [claudeKeySaved, setClaudeKeySaved] = useState(false);
  const [claudeKeyError, setClaudeKeyError] = useState<string | null>(null);
  const [geminiApiKey, setGeminiApiKey] = useState("");
  const [geminiKeySaving, setGeminiKeySaving] = useState(false);
  const [geminiKeySaved, setGeminiKeySaved] = useState(false);
  const [geminiKeyError, setGeminiKeyError] = useState<string | null>(null);
  const [geminiKeyConfigured, setGeminiKeyConfigured] = useState(false);
  // Usage is keyed by model across providers (see ai_dj/llm.py get_usage) —
  // one shared panel, not per-provider state.
  const [aiDjUsage, setAiDjUsage] = useState<Record<string, { inputTokens: number; outputTokens: number; requests: number; estimatedCostUsd: number; errors: number; lastError: string | null }> | null>(null);
  const [aiDjUsageError, setAiDjUsageError] = useState<string | null>(null);
  const [llmLog, setLlmLog] = useState<{ ts: string; model: string; system: string; prompt: string; ok: boolean; error?: string; durationMs?: number; source?: "pi" | "service" }[] | null>(null);
  // ── Run-type BPM override state (blank = no override) ─────────────────────
  const [bpmOv, setBpmOv] = useState<Record<string, { min: string; max: string }>>({
    warmup: { min: "", max: "" }, work: { min: "", max: "" }, easy: { min: "", max: "" },
    cooldown: { min: "", max: "" }, rest: { min: "", max: "" },
  });
  const [bpmOvSaving, setBpmOvSaving] = useState(false);
  const [bpmOvSaved, setBpmOvSaved] = useState(false);
  const [bpmOvError, setBpmOvError] = useState<string | null>(null);
  const [waking, setWaking] = useState(false);
  const [wakeMsg, setWakeMsg] = useState<string | null>(null);
  const wakePollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── 2FA state ────────────────────────────────────────────────────────────
  const [totpEnabled, setTotpEnabled] = useState<boolean | null>(null);
  const [totpQr, setTotpQr] = useState<string | null>(null);
  const [totpSecret, setTotpSecret] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [totpBusy, setTotpBusy] = useState(false);
  const [totpError, setTotpError] = useState<string | null>(null);
  const [totpMsg, setTotpMsg] = useState<string | null>(null);

  // ── Garmin DB state ────────────────────────────────────────────────────────
  const [garminDbPath, setGarminDbPath] = useState("/home/scott/HealthData/DBs");
  const [garminSaving, setGarminSaving] = useState(false);
  const [garminSaved, setGarminSaved] = useState(false);
  const [garminError, setGarminError] = useState<string | null>(null);
  const [garminConfigured, setGarminConfigured] = useState(false);
  const [syncStatus, setSyncStatus] = useState<{
    running: boolean;
    progress: {
      percent: number; current: number; total: number;
      elapsed: string; eta: string; speed: string; section: string;
    } | null;
    logTail: string[];
    lastRun: string | null;
  } | null>(null);

  // ── Active library tracks (feeds Run BPM limits' live per-range counts) ────
  const [activeTracks, setActiveTracks] = useState<{ uri: string; name: string; artist: string; bpm: number }[]>([]);
  const [activeTracksLoaded, setActiveTracksLoaded] = useState(false);

  const loadActiveTracks = useCallback(() => {
    fetch("/api/settings/active-tracks")
      .then(r => r.json())
      .then((d: { tracks?: typeof activeTracks }) => { setActiveTracks(d.tracks ?? []); setActiveTracksLoaded(true); })
      .catch(() => setActiveTracksLoaded(true));
  }, []);
  useEffect(() => { loadActiveTracks(); }, [loadActiveTracks]);

  // ── Library coverage report: how much of the library falls within a BPM
  // range the AI DJ mixer could ever pick a track from (per-kind Settings
  // overrides), vs. sitting outside every kind's range — and how many
  // confirmed "Today's Run" mixes each track has actually featured in, so
  // unused-but-in-range tracks are visible too. ──
  interface CoverageTrack { uri: string; name: string; artist: string; played: number; inRange: boolean }
  interface CoverageBucket { bpm: number; count: number; inRange: boolean; played: number; tracks: CoverageTrack[] }
  const [coverage, setCoverage] = useState<{
    buckets: CoverageBucket[]; totalTracks: number; inRangeTracks: number; outOfRangeTracks: number;
    kindRanges: { kind: string; min: number; max: number }[];
  } | null>(null);
  const [coverageLoaded, setCoverageLoaded] = useState(false);
  const [expandedBucket, setExpandedBucket] = useState<number | null>(null);
  const loadCoverage = useCallback(() => {
    fetch("/api/settings/library-coverage")
      .then(r => r.json())
      .then((d: typeof coverage) => { setCoverage(d); setCoverageLoaded(true); })
      .catch(() => setCoverageLoaded(true));
  }, []);
  useEffect(() => { loadCoverage(); }, [loadCoverage]);

  // ── Copy every "presentable" (in-range) coverage track to another
  // playlist — an existing known one (append + dedupe, same as Sprint BPM's
  // copy) or a brand-new one (created on Spotify, registered locally). ──
  const [coverageCopyTarget, setCoverageCopyTarget] = useState(""); // known playlist id, or "__new__"
  const [coverageNewPlaylistName, setCoverageNewPlaylistName] = useState("");
  const [coverageCopying, setCoverageCopying] = useState(false);
  const [coverageCopyMsg, setCoverageCopyMsg] = useState<string | null>(null);
  const [coverageCopyError, setCoverageCopyError] = useState<string | null>(null);

  async function copyCoverageTracksToPlaylist() {
    if (!coverageCopyTarget) { setCoverageCopyError("Choose a target playlist first."); return; }
    const isNew = coverageCopyTarget === "__new__";
    if (isNew && !coverageNewPlaylistName.trim()) { setCoverageCopyError("Name the new playlist first."); return; }

    const presentableUris = Array.from(new Set(
      (coverage?.buckets ?? []).flatMap(b => b.tracks.filter(t => t.inRange).map(t => t.uri))
    ));
    if (presentableUris.length === 0) { setCoverageCopyError("No presentable tracks to copy."); return; }

    const token = await freshSpotifyToken();
    if (!token) { setCoverageCopyError("Not signed in"); return; }

    setCoverageCopying(true);
    setCoverageCopyError(null);
    setCoverageCopyMsg(null);
    try {
      if (isNew) {
        // /me/playlists (not /users/{id}/playlists) — this app's other
        // create-playlist path (lib/spotify-playlist.ts) already found the
        // user-id-scoped endpoint 403s unreliably; /me/playlists targets
        // "the current user" directly and works.
        const createRes = await fetch("https://api.spotify.com/v1/me/playlists", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ name: coverageNewPlaylistName.trim(), public: false, description: "Presentable tracks copied from Library Coverage" }),
        });
        if (!createRes.ok) throw new Error(`[POST /me/playlists] Spotify ${createRes.status}: ${await createRes.text()}`);
        const created = await createRes.json() as { id: string };

        try {
          await addTracksBrowser(created.id, presentableUris, token);
        } catch (e) {
          throw new Error(`[POST /playlists/${created.id}/items] ${e instanceof Error ? e.message : String(e)}`);
        }

        const res = await fetch("/api/settings/register-playlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: coverageNewPlaylistName.trim(), id: created.id, uris: presentableUris }),
        });
        const d = await res.json() as { error?: string };
        if (!res.ok) throw new Error(d.error ?? "Failed to register new playlist locally");

        setCoverageCopyMsg(`Created "${coverageNewPlaylistName.trim()}" and copied ${presentableUris.length} tracks`);
        setCoverageNewPlaylistName("");
        loadPlaylistList();
      } else {
        await addTracksBrowser(coverageCopyTarget, presentableUris, token);
        const res = await fetch("/api/tracks/copy-to-playlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetPlaylistId: coverageCopyTarget, uris: presentableUris }),
        });
        const d = await res.json() as { error?: string; merged?: number };
        if (!res.ok) throw new Error(d.error ?? "Failed to copy");
        const targetName = knownPlaylists.find(p => p.id === coverageCopyTarget)?.name ?? "target playlist";
        setCoverageCopyMsg(
          `Copied ${presentableUris.length} tracks to "${targetName}"` +
          ((d.merged ?? 0) > 0 ? ` · ${d.merged} already there had data filled in` : "")
        );
      }
    } catch (e) {
      setCoverageCopyError(e instanceof Error ? e.message : "Failed to copy tracks");
    } finally {
      setCoverageCopying(false);
    }
  }

  // ── Delete every "never usable" (out-of-range for every run type) coverage
  // track from the active playlist — both Spotify (browser token, batched in
  // groups of 100) and the local CSV (one batch server call). Irreversible,
  // so the button requires an explicit confirm click before it fires. ──
  const [coverageDeleting, setCoverageDeleting] = useState(false);
  const [coverageDeleteMsg, setCoverageDeleteMsg] = useState<string | null>(null);
  const [coverageDeleteError, setCoverageDeleteError] = useState<string | null>(null);
  const [coverageDeleteConfirm, setCoverageDeleteConfirm] = useState(false);

  async function deleteNeverUsableTracks() {
    const outOfRangeUris = Array.from(new Set(
      (coverage?.buckets ?? []).flatMap(b => b.tracks.filter(t => !t.inRange).map(t => t.uri))
    ));
    if (outOfRangeUris.length === 0) return;

    if (!coverageDeleteConfirm) { setCoverageDeleteConfirm(true); return; }
    setCoverageDeleteConfirm(false);

    const token = await freshSpotifyToken();
    if (!token) { setCoverageDeleteError("Not signed in"); return; }
    if (!activePlaylistId) { setCoverageDeleteError("No active playlist"); return; }

    setCoverageDeleting(true);
    setCoverageDeleteError(null);
    setCoverageDeleteMsg(null);
    try {
      for (let i = 0; i < outOfRangeUris.length; i += 100) {
        const chunk = outOfRangeUris.slice(i, i + 100);
        const res = await fetch(`https://api.spotify.com/v1/playlists/${activePlaylistId}/items`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ items: chunk.map(uri => ({ uri })) }),
        });
        if (!res.ok) throw new Error(`[DELETE /playlists/${activePlaylistId}/items] Spotify ${res.status}: ${await res.text()}`);
      }

      const csvRes = await fetch("/api/tracks/delete", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spotifyUris: outOfRangeUris }),
      });
      const csvData = await csvRes.json() as { error?: string; removed?: number };
      if (!csvRes.ok) throw new Error(csvData.error ?? "Failed to remove from local library");

      setCoverageDeleteMsg(`Deleted ${outOfRangeUris.length} never-usable tracks from Spotify and the local library`);
      invalidateRunningPlaylistCache();
      loadActiveTracks();
      loadCoverage();
      loadPlaylistList();
    } catch (e) {
      setCoverageDeleteError(e instanceof Error ? e.message : "Failed to delete tracks");
    } finally {
      setCoverageDeleting(false);
    }
  }

  // Live progress for a running CSV heal sweep (BPM/audio-feature backfill
  // after a big import) — polled while running so a large library doesn't
  // look silently stuck. See lib/csv-heal.ts.
  const [healProgress, setHealProgress] = useState<{
    running: boolean; phase: "uris" | "features" | "duration" | "genres" | null;
    current: number; total: number; healedSoFar: number;
    startedAt: string | null; finishedAt: string | null;
    spotifyRetryAt: string | null;
    log: { at: string; text: string }[];
  } | null>(null);

  // Instant column-blank breakdown from the moment "Check for missing data"
  // was clicked (before the slower heal sweep even starts) — e.g. "912
  // tracks, 40 missing duration, 15 missing genres".
  const [healStatus, setHealStatus] = useState<{
    total: number; missingUri: number; missingDuration: number; missingGenres: number;
    missingFeatures: Record<string, number>;
  } | null>(null);

  // ── CSV import state ───────────────────────────────────────────────────────
  const [csvPlaylistName, setCsvPlaylistName] = useState("");
  const [csvStagedText, setCsvStagedText] = useState<string | null>(null);
  const [csvFileName, setCsvFileName] = useState<string | null>(null);
  const [csvTrackCount, setCsvTrackCount] = useState<number | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [csvSaving, setCsvSaving] = useState(false);
  const [csvSaved, setCsvSaved] = useState(false);
  const [csvImportMode, setCsvImportMode] = useState<"overwrite" | "append">("overwrite");
  const csvFileRef = useRef<HTMLInputElement>(null);

  // ── Append-to-active-playlist CSV import state ─────────────────────────────
  const [appendCsvStagedText, setAppendCsvStagedText] = useState<string | null>(null);
  const [appendCsvFileName, setAppendCsvFileName] = useState<string | null>(null);
  const [appendCsvTrackCount, setAppendCsvTrackCount] = useState<number | null>(null);
  const [appendCsvError, setAppendCsvError] = useState<string | null>(null);
  const [appendCsvSaving, setAppendCsvSaving] = useState(false);
  const [appendCsvSaved, setAppendCsvSaved] = useState<{ appended: number; merged: number } | null>(null);
  const appendCsvFileRef = useRef<HTMLInputElement>(null);

  // ── Previously-deleted tracks review (shared by all import flows) ──────────
  // The triggering flow stashes a resume continuation; the review panel calls
  // it with the URIs the user ticked to override (empty = reject all).
  const [deletedReview, setDeletedReview] = useState<{ rejected: RejectedTrack[]; resume: (allowUris: string[]) => void } | null>(null);

  // ── Deleted Tracks tab ──────────────────────────────────────────────────────
  const [deletedTracksList, setDeletedTracksList] = useState<RejectedTrack[] | null>(null);
  const [deletedTracksLoading, setDeletedTracksLoading] = useState(false);
  const [deletedTracksError, setDeletedTracksError] = useState<string | null>(null);
  const [forgettingUris, setForgettingUris] = useState<Set<string>>(new Set());

  const [cronRunning, setCronRunning] = useState(false);
  const [cronResults, setCronResults] = useState<{ name: string; matched: number; found: number; error?: string }[] | null>(null);
  const [cronSummary, setCronSummary] = useState<{ totalMatched: number; dedupRemoved: number; dedupRemaining: number } | null>(null);
  const [cronError, setCronError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/settings/hr-zones")
      .then(r => r.json())
      .then((data: { zones: RunningZone[]; maxHR?: number; restingHR?: number; lthr?: number; source?: "manual" | "lthr" | "garmin" | "strava" }) => {
        if (data.zones) setZones(data.zones.map(z => ({ min: z.hrMin, max: z.hrMax })));
        if (data.maxHR)     setMaxHR(data.maxHR);
        if (data.restingHR) setRestingHR(data.restingHR);
        if (data.lthr)      setLthr(data.lthr);
        if (data.source)    setZoneSource(data.source);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetch("/api/settings/runna-url")
      .then(r => r.json())
      .then((d: { icsUrl?: string | null }) => { if (d.icsUrl) setRunnaUrl(d.icsUrl); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/settings/ntfy")
      .then(r => r.json())
      .then((d: { topic?: string | null }) => { if (d.topic) setNtfyTopic(d.topic); })
      .catch(() => {});
  }, []);

  function loadStravaStatus() {
    fetch("/api/settings/strava")
      .then(r => r.json())
      .then((d: { clientId?: string; hasSecret?: boolean; connected?: boolean; athleteName?: string | null }) => {
        if (d.clientId) setStravaClientId(d.clientId);
        setStravaHasSecret(!!d.hasSecret);
        setStravaConnected(!!d.connected);
        setStravaAthleteName(d.athleteName ?? null);
      })
      .catch(() => {});
  }
  useEffect(loadStravaStatus, []);

  function loadStravaWebhookStatus() {
    fetch("/api/strava/webhook/subscribe")
      .then(r => r.json())
      .then((d: { subscribed?: boolean }) => setStravaWebhookSubscribed(!!d.subscribed))
      .catch(() => {});
  }
  useEffect(loadStravaWebhookStatus, []);

  useEffect(() => {
    fetch("/api/settings/metoffice")
      .then(r => r.json())
      .then((d: { hasKey?: boolean; postcode?: string }) => {
        setMetofficeHasKey(!!d.hasKey);
        if (d.postcode) setMetofficePostcode(d.postcode);
      })
      .catch(() => {});
  }, []);

  async function saveMetoffice() {
    setMetofficeSaving(true);
    setMetofficeSaved(false);
    setMetofficeError(null);
    try {
      const res = await fetch("/api/settings/metoffice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: metofficeKey.trim(), postcode: metofficePostcode.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setMetofficeSaved(true);
      setMetofficeHasKey(true);
      setMetofficeKey("");
    } catch (e) {
      setMetofficeError(e instanceof Error ? e.message : "Failed to save — try again.");
    } finally {
      setMetofficeSaving(false);
    }
  }

  async function unsubscribeStravaWebhook() {
    setStravaWebhookLoading(true);
    setStravaWebhookError(null);
    try {
      const res = await fetch("/api/strava/webhook/subscribe", { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setStravaWebhookSubscribed(false);
    } catch (e) {
      setStravaWebhookError(e instanceof Error ? e.message : "Failed to unsubscribe");
    } finally {
      setStravaWebhookLoading(false);
    }
  }

  async function subscribeStravaWebhook() {
    setStravaWebhookLoading(true);
    setStravaWebhookError(null);
    try {
      const res = await fetch("/api/strava/webhook/subscribe", { method: "POST" });
      const d = await res.json() as { error?: string };
      if (!res.ok) throw new Error(d.error ?? "Failed to subscribe");
      setStravaWebhookSubscribed(true);
    } catch (e) {
      setStravaWebhookError(e instanceof Error ? e.message : "Failed to subscribe");
    } finally {
      setStravaWebhookLoading(false);
    }
  }

  async function saveStrava() {
    setStravaSaving(true);
    setStravaSaved(false);
    setStravaError(null);
    try {
      const res = await fetch("/api/settings/strava", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: stravaClientId.trim(), clientSecret: stravaClientSecret.trim() }),
      });
      const d = await res.json() as { error?: string };
      if (!res.ok) throw new Error(d.error ?? "Failed to save");
      setStravaSaved(true);
      setStravaClientSecret("");
      loadStravaStatus();
    } catch (e) {
      setStravaError(e instanceof Error ? e.message : "Failed to save — try again.");
    } finally {
      setStravaSaving(false);
    }
  }

  useEffect(() => {
    fetch("/api/settings/garmin")
      .then(r => r.json())
      .then((d: { configured?: boolean; config?: { dbPath?: string } }) => {
        setGarminConfigured(d.configured ?? false);
        if (d.config?.dbPath) setGarminDbPath(d.config.dbPath);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/settings/ai-dj")
      .then(r => r.json())
      .then((d: { url?: string; enabled?: boolean; autoPlaylist?: boolean; wolMac?: string; provider?: string; claudeModel?: string; claudeEffort?: string; geminiModel?: string }) => {
        if (d.url) setAiDjUrl(d.url);
        setAiDjEnabled(d.enabled ?? false);
        setAiDjAutoPlaylist(d.autoPlaylist ?? true);
        setAiDjWolMac(d.wolMac ?? "");
        setAiDjProvider(d.provider === "claude" ? "claude" : d.provider === "gemini" ? "gemini" : "local");
        if (d.claudeModel) setAiDjClaudeModel(d.claudeModel);
        if (d.claudeEffort) setAiDjClaudeEffort(d.claudeEffort);
        if (d.geminiModel) setAiDjGeminiModel(d.geminiModel);
      })
      .catch(() => {});
  }, []);

  function loadAiDjUsage() {
    setAiDjUsageError(null);
    fetch("/api/settings/ai-dj/usage")
      .then(r => r.json())
      .then((d: { models?: typeof aiDjUsage; error?: string }) => {
        if (d.error) { setAiDjUsageError(d.error); return; }
        setAiDjUsage(d.models ?? {});
      })
      .catch(() => setAiDjUsageError("Could not read usage — try again."));
  }

  function loadClaudeKeyStatus() {
    fetch("/api/settings/ai-dj/claude-key")
      .then(r => r.json())
      .then((d: { configured?: boolean }) => setClaudeKeyConfigured(!!d.configured))
      .catch(() => {});
  }

  function loadLlmLog() {
    fetch("/api/settings/ai-dj/llm-log")
      .then(r => r.json())
      .then((d: { entries?: typeof llmLog }) => setLlmLog(d.entries ?? []))
      .catch(() => setLlmLog([]));
  }

  function loadGeminiKeyStatus() {
    fetch("/api/settings/ai-dj/gemini-key")
      .then(r => r.json())
      .then((d: { configured?: boolean }) => setGeminiKeyConfigured(!!d.configured))
      .catch(() => {});
  }

  useEffect(() => {
    if (aiDjProvider === "claude") { loadAiDjUsage(); loadClaudeKeyStatus(); }
    else if (aiDjProvider === "gemini") { loadAiDjUsage(); loadGeminiKeyStatus(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiDjProvider]);

  useEffect(() => {
    if (aiDjEnabled) loadLlmLog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiDjEnabled]);

  async function saveClaudeApiKey() {
    setClaudeKeySaving(true);
    setClaudeKeySaved(false);
    setClaudeKeyError(null);
    try {
      const res = await fetch("/api/settings/ai-dj/claude-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: claudeApiKey.trim() }),
      });
      const d = await res.json() as { error?: string };
      if (!res.ok) throw new Error(d.error ?? "Failed to save");
      setClaudeKeySaved(true);
      setClaudeApiKey("");
      setClaudeKeyConfigured(true);
    } catch (e) {
      setClaudeKeyError(e instanceof Error ? e.message : "Failed to save — try again.");
    } finally {
      setClaudeKeySaving(false);
    }
  }

  async function saveGeminiApiKey() {
    setGeminiKeySaving(true);
    setGeminiKeySaved(false);
    setGeminiKeyError(null);
    try {
      const res = await fetch("/api/settings/ai-dj/gemini-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: geminiApiKey.trim() }),
      });
      const d = await res.json() as { error?: string };
      if (!res.ok) throw new Error(d.error ?? "Failed to save");
      setGeminiKeySaved(true);
      setGeminiApiKey("");
      setGeminiKeyConfigured(true);
    } catch (e) {
      setGeminiKeyError(e instanceof Error ? e.message : "Failed to save — try again.");
    } finally {
      setGeminiKeySaving(false);
    }
  }

  useEffect(() => {
    fetch("/api/settings/bpm-overrides")
      .then(r => r.json())
      .then((d: { overrides?: Record<string, { min?: number; max?: number }> }) => {
        if (!d.overrides) return;
        setBpmOv(prev => {
          const next = { ...prev };
          Object.keys(next).forEach(kind => {
            const o = d.overrides![kind];
            if (o) next[kind] = { min: o.min ? String(o.min) : "", max: o.max ? String(o.max) : "" };
          });
          return next;
        });
      })
      .catch(() => {});
  }, []);

  async function saveBpmOverrides() {
    setBpmOvSaving(true);
    setBpmOvSaved(false);
    setBpmOvError(null);
    try {
      const res = await fetch("/api/settings/bpm-overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overrides: bpmOv }),
      });
      const d = await res.json() as { error?: string };
      if (!res.ok) throw new Error(d.error ?? "Failed to save");
      setBpmOvSaved(true);
      loadCoverage();
    } catch (e) {
      setBpmOvError(e instanceof Error ? e.message : "Failed to save — try again.");
    } finally {
      setBpmOvSaving(false);
    }
  }

  useEffect(() => {
    fetch("/api/settings/cron")
      .then(r => r.json())
      .then((d: { available?: boolean; jobs?: { key: string; installed: boolean; enabled: boolean; time: string; day: number | null }[]; log?: { ts: string; job: string; message: string }[] }) => {
        setCronAvailable(d.available ?? false);
        setCronJobs(d.jobs ?? []);
        setCronLog(d.log ?? []);
      })
      .catch(() => setCronAvailable(false));
  }, []);

  function patchCronJob(key: string, patch: Partial<{ enabled: boolean; time: string; day: number | null }>) {
    setCronJobs(jobs => jobs.map(j => (j.key === key ? { ...j, ...patch } : j)));
    setCronSaved(false);
  }

  async function saveCronJobs() {
    setCronSaving(true);
    setCronSaved(false);
    setCronJobsError(null);
    try {
      const res = await fetch("/api/settings/cron", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobs: cronJobs.filter(j => j.installed).map(({ key, enabled, time, day }) => ({ key, enabled, time, day })) }),
      });
      const d = await res.json() as { error?: string; jobs?: typeof cronJobs; log?: typeof cronLog };
      if (!res.ok) throw new Error(d.error ?? "Failed to save");
      if (d.jobs) setCronJobs(d.jobs);
      if (d.log) setCronLog(d.log);
      setCronSaved(true);
    } catch (e) {
      setCronJobsError(e instanceof Error ? e.message : "Failed to save — try again.");
    } finally {
      setCronSaving(false);
    }
  }

  // Debounced connection check whenever the URL changes (or a manual refresh
  // is requested via the nonce), plus a periodic recheck (every 60s) so the
  // indicator doesn't go stale while the page is open.
  const [aiDjCheckNonce, setAiDjCheckNonce] = useState(0);

  // ── Scheduled jobs (crontab) state ────────────────────────────────────────
  const [cronJobs, setCronJobs] = useState<{ key: string; installed: boolean; enabled: boolean; time: string; day: number | null }[]>([]);
  const [cronAvailable, setCronAvailable] = useState(true);
  const [cronSaving, setCronSaving] = useState(false);
  const [cronSaved, setCronSaved] = useState(false);
  const [cronJobsError, setCronJobsError] = useState<string | null>(null);
  const [cronLog, setCronLog] = useState<{ ts: string; job: string; message: string }[]>([]);

  // ── Known playlists (switch / delete) ──────────────────────────────────────
  const [knownPlaylists, setKnownPlaylists] = useState<{ name: string; id: string; csvFile: string; trackCount?: number | null }[]>([]);
  const [playlistsLoaded, setPlaylistsLoaded] = useState(false);
  const [activePlaylistId, setActivePlaylistId] = useState<string | null>(null);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ name: string; id: string; csvFile: string } | null>(null);
  const [deleteUnfollow, setDeleteUnfollow] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [playlistListError, setPlaylistListError] = useState<string | null>(null);

  // ── Sync from Spotify: catch up on tracks added to the active playlist
  // directly in Spotify (outside the app), which never went through the
  // app's own add flows and so never joined the local CSV/BPM library. ──
  const [syncingFromSpotify, setSyncingFromSpotify] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  async function syncFromSpotify() {
    if (!activePlaylistId) return;
    setSyncingFromSpotify(true);
    setSyncMsg(null);
    setSyncError(null);
    try {
      const token = await freshSpotifyToken();
      if (!token) throw new Error("Not signed in to Spotify");

      // Page through the full playlist. No fields= projection — its syntax
      // is unreliable across Spotify API versions, so fetch full track
      // objects instead (slightly heavier, but avoids silently getting back
      // an empty items array from a malformed projection).
      const playlistTracks: { uri: string; name: string; artist: string }[] = [];
      let url: string | null =
        `https://api.spotify.com/v1/playlists/${activePlaylistId}/items?limit=100`;
      let pages = 0;
      while (url) {
        const res: Response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        const bodyText = await res.text();
        if (!res.ok) throw new Error(`Spotify ${res.status} on page ${pages}: ${bodyText.slice(0, 300)}`);
        pages++;
        let data: {
          next: string | null;
          // The track data itself lives directly under item.item (the
          // "track" key inside it is a boolean flag meaning "this is a
          // track, not an episode" — not a further nesting level).
          // Confirmed against a live /items response.
          items: { is_local: boolean; item: { uri: string; name: string; artists: { name: string }[]; is_local: boolean } | null }[];
        };
        try {
          data = JSON.parse(bodyText);
        } catch {
          throw new Error(`Non-JSON response on page ${pages}: ${bodyText.slice(0, 300)}`);
        }
        for (const entry of data.items ?? []) {
          const t = entry.item;
          if (!t || t.is_local || !t.uri?.startsWith("spotify:track:")) continue;
          playlistTracks.push({ uri: t.uri, name: t.name, artist: t.artists.map(a => a.name).join(", ") });
        }
        url = data.next;
      }
      if (playlistTracks.length === 0) {
        throw new Error(`Spotify returned 0 tracks across ${pages} page(s) for playlist ${activePlaylistId}`);
      }

      // Dedupe against the library — same endpoint the BBC add flow uses,
      // so a track added here twice (or already synced) is never re-added.
      const ur = await fetch("/api/tracks/uris");
      const ud = await ur.json() as { uris?: string[] };
      const existingUris = new Set(ud.uris ?? []);
      const missing = playlistTracks.filter(t => !existingUris.has(t.uri));

      if (missing.length === 0) {
        setSyncMsg(`Up to date — all ${playlistTracks.length} tracks already in the library`);
        return;
      }

      // Same enrichment + CSV-write split as the BBC add flow: an
      // enrichment failure must not prevent the CSV write, or a track ends
      // up looking synced (it's in Spotify) but silently missing locally.
      let features: Record<string, { tempo: number; key: number; mode: number; energy: number; danceability: number; valence: number }> = {};
      let enriched = 0;
      try {
        const er = await fetch("/api/bpm/enrich", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tracks: missing.map(t => ({ id: t.uri.split(":").pop()!, name: t.name, artist: t.artist })),
          }),
        });
        const ed = await er.json() as { features?: typeof features };
        features = ed.features ?? {};
        enriched = Object.keys(features).length;
      } catch { /* enrichment is best-effort — the CSV write below still runs */ }

      const rows = missing.map(t => {
        const id = t.uri.split(":").pop()!;
        return { uri: t.uri, name: t.name, artist: t.artist, ...features[id] };
      });
      const ar = await fetch("/api/tracks/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tracks: rows }),
      });
      const ad = await ar.json() as { added?: number; error?: string };
      if (!ar.ok || ad.error) throw new Error(ad.error ?? `HTTP ${ar.status}`);

      const added = ad.added ?? rows.length;
      const noBpm = added - enriched;
      setSyncMsg(
        `Added ${added} new track${added !== 1 ? "s" : ""} from Spotify` +
        (enriched > 0 ? ` · ${enriched} with BPM data` : "") +
        (noBpm > 0 ? ` · ${noBpm} without BPM data (will retry)` : "")
      );
      invalidateRunningPlaylistCache();
      fetchHealStatus();
      loadActiveTracks();
      loadCoverage();
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncingFromSpotify(false);
    }
  }

  function loadPlaylistList() {
    fetch("/api/settings/playlists")
      .then(r => r.json())
      .then((d: { playlists?: { name: string; id: string; csvFile: string; trackCount?: number | null }[]; activeId?: string }) => {
        setKnownPlaylists(d.playlists ?? []);
        setActivePlaylistId(d.activeId ?? null);
        setPlaylistsLoaded(true);
      })
      .catch(() => {});
  }

  useEffect(() => {
    loadPlaylistList();
  }, []);

  async function switchActivePlaylist(id: string) {
    setSwitchingId(id);
    setPlaylistListError(null);
    try {
      // A running heal sweep already has the old playlist's CSV path
      // captured in memory — stop it and clear its log/status so nothing
      // stale from the previous playlist lingers on screen.
      if (healProgress?.running) {
        fetch("/api/settings/heal-cancel", { method: "POST" }).catch(() => {});
      }
      setHealProgress(null);
      setHealStatus(null);
      setHealNowError(null);

      const res = await fetch("/api/settings/playlists", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const d = await res.json() as { error?: string; name?: string };
      if (!res.ok) throw new Error(d.error ?? "Failed to switch");
      invalidateRunningPlaylistCache();
      setActivePlaylistId(id);
      // The active playlist's CSV backs both of these — refetch so they
      // reflect the newly-active library instead of the previous one.
      loadActiveTracks();
      loadCoverage();
      fetchHealStatusSnapshot();
    } catch (e) {
      setPlaylistListError(e instanceof Error ? e.message : "Failed to switch playlist");
    } finally {
      setSwitchingId(null);
    }
  }

  async function confirmDeletePlaylist() {
    if (!deleteTarget) return;
    setDeleting(true);
    setPlaylistListError(null);
    try {
      const res = await fetch("/api/settings/playlists", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: deleteTarget.id, unfollowSpotify: deleteUnfollow }),
      });
      const d = await res.json() as { error?: string; spotifyError?: string | null };
      if (!res.ok) throw new Error(d.error ?? "Failed to delete");
      if (d.spotifyError) setPlaylistListError(`Removed locally, but Spotify unfollow failed: ${d.spotifyError}`);
      invalidateRunningPlaylistCache();
      setDeleteTarget(null);
      loadPlaylistList();
      // Deleting the active playlist switches active to another one
      // server-side — refetch either way so these reflect whichever
      // playlist's CSV is active now.
      loadActiveTracks();
      loadCoverage();
    } catch (e) {
      setPlaylistListError(e instanceof Error ? e.message : "Failed to delete playlist");
    } finally {
      setDeleting(false);
    }
  }

  // Resolve/create a playlist by name via the Spotify API and make it the
  // active one — shared by both import flows below, which each ask for a
  // name up front rather than relying on a separate "default playlist" field.
  async function resolvePlaylistByName(name: string): Promise<{ id: string; name: string; csvFile: string }> {
    const res = await fetch("/api/settings/playlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const d = await res.json() as { error?: string; id?: string; name?: string; csvFile?: string };
    if (!res.ok || !d.id) throw new Error(d.error ?? "Failed to resolve playlist");
    invalidateRunningPlaylistCache();
    loadPlaylistList();
    return { id: d.id, name: d.name ?? name, csvFile: d.csvFile ?? "Running.csv" };
  }
  useEffect(() => {
    const url = aiDjUrl.trim();
    if (!url) { setAiDjHealth("idle"); setAiDjHealthMsg(null); return; }

    let cancelled = false;
    const check = async () => {
      setAiDjHealth("checking");
      try {
        const res = await fetch(`/api/ai-dj/health?url=${encodeURIComponent(url)}`);
        const d = await res.json() as { ok?: boolean; llm?: boolean; claude?: boolean; error?: string };
        if (cancelled) return;
        setAiDjHealth(d.ok ? "ok" : "down");
        setAiDjHealthLlm(!!d.llm);
        setAiDjHealthClaude(!!d.claude);
        setAiDjHealthMsg(d.ok ? null : (d.error ?? "Unreachable"));
      } catch {
        if (!cancelled) { setAiDjHealth("down"); setAiDjHealthMsg("Unreachable"); }
      }
    };

    const debounce = setTimeout(check, aiDjCheckNonce > 0 ? 0 : 500);
    const interval = setInterval(check, 60000);
    return () => { cancelled = true; clearTimeout(debounce); clearInterval(interval); };
  }, [aiDjUrl, aiDjCheckNonce]);

  // Sync status polling — 20s when active, 5min when idle
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncCancelledRef = useRef(false);

  const fetchSyncStatus = useCallback(async () => {
    if (syncCancelledRef.current) return;
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    try {
      const res = await fetch("/api/settings/garmin/sync-status");
      if (res.ok && !syncCancelledRef.current) {
        const data = await res.json();
        setSyncStatus(data);
        syncTimerRef.current = setTimeout(fetchSyncStatus, data.running ? 20_000 : 300_000);
      }
    } catch {
      if (!syncCancelledRef.current)
        syncTimerRef.current = setTimeout(fetchSyncStatus, 300_000);
    }
  }, []);

  useEffect(() => {
    if (!garminConfigured) return;
    syncCancelledRef.current = false;
    fetchSyncStatus();
    return () => {
      syncCancelledRef.current = true;
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    };
  }, [garminConfigured, fetchSyncStatus]);

  // CSV heal-sweep progress polling — 3s while running, checked once on
  // mount in case a sweep from a prior save is still in flight, stops once
  // it reports done.
  const healTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const healCancelledRef = useRef(false);

  // Column-blank breakdown (the "N tracks, N missing genres…" card) —
  // fetched on mount so a page reload doesn't lose it, and re-fetched once
  // a running sweep finishes so the numbers reflect what actually got
  // healed instead of the stale pre-sweep snapshot from when the button
  // was clicked.
  const fetchHealStatusSnapshot = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/heal-now-status");
      if (!res.ok) return;
      const data = await res.json() as { status?: typeof healStatus };
      if (data.status) setHealStatus(data.status);
    } catch { /* best-effort */ }
  }, []);

  useEffect(() => { fetchHealStatusSnapshot(); }, [fetchHealStatusSnapshot]);

  const wasRunningRef = useRef(false);

  const fetchHealStatus = useCallback(async () => {
    if (healCancelledRef.current) return;
    if (healTimerRef.current) clearTimeout(healTimerRef.current);
    try {
      const res = await fetch("/api/settings/heal-status");
      if (res.ok && !healCancelledRef.current) {
        const data = await res.json() as { progress?: typeof healProgress };
        setHealProgress(data.progress ?? null);
        if (data.progress?.running) {
          wasRunningRef.current = true;
          healTimerRef.current = setTimeout(fetchHealStatus, 3_000);
        } else if (wasRunningRef.current) {
          // Sweep just finished — refresh the column-blank snapshot so it
          // shows post-heal numbers instead of the pre-heal click-time ones.
          wasRunningRef.current = false;
          fetchHealStatusSnapshot();
        }
      }
    } catch { /* stop polling on error — next save will restart it */ }
  }, [fetchHealStatusSnapshot]);

  useEffect(() => {
    healCancelledRef.current = false;
    fetchHealStatus();
    return () => {
      healCancelledRef.current = true;
      if (healTimerRef.current) clearTimeout(healTimerRef.current);
    };
  }, [fetchHealStatus]);

  const [healNowError, setHealNowError] = useState<string | null>(null);

  // "Check for missing data" button — triggers the same heal sweep that
  // already runs automatically after every CSV write, on demand for the
  // active playlist. The progress bar above (healProgress) picks it up via
  // the existing polling once it starts running.
  async function healNow() {
    setHealNowError(null);
    setHealStatus(null);
    try {
      const res = await fetch("/api/settings/heal-now", { method: "POST" });
      if (!res.ok) throw new Error();
      const data = await res.json() as { status?: typeof healStatus };
      setHealStatus(data.status ?? null);
      // The sweep starts in the background (fire-and-forget on the server),
      // so an immediate poll can race its first writeProgress() call and
      // read a stale/finished progress file from a previous run — a short
      // sweep (e.g. Spotify already known rate-limited, so it skips straight
      // to Deezer) can finish in well under a second. Re-poll repeatedly for
      // a few seconds so the running state/log actually gets picked up
      // instead of the log window freezing on whatever the very first,
      // possibly-stale poll saw.
      for (const delay of [0, 400, 800, 1500, 2500, 4000, 6000]) {
        setTimeout(fetchHealStatus, delay);
      }
    } catch {
      setHealNowError("Failed to start — try again.");
    }
  }

  useEffect(() => {
    fetch("/api/bbc/programmes")
      .then(r => r.json())
      .then((d: { programmes?: BbcProgramme[] }) => {
        if (d.programmes?.length) setBbcProgrammes(d.programmes);
      })
      .catch(() => {})
      .finally(() => setBbcLoading(false));
  }, []);

  // Auto-open browser when arriving from dashboard edit/add links
  useEffect(() => {
    if (bbcMode && !bbcLoading) {
      setBbcBrowserMode(bbcMode);
      setBbcBrowserTargetPid(bbcReplacePid);
      setBbcBrowserTargetName(bbcReplaceName);
      setBbcBrowserOpen(true);
    }
  }, [bbcMode, bbcReplacePid, bbcReplaceName, bbcLoading]);

  // ── HR zone handlers ───────────────────────────────────────────────────────
  const handleMaxHR = (val: string) => {
    const n = parseInt(val) || 0;
    setMaxHR(n);
    if (n > restingHR) { setZones(calcZones(n, restingHR)); setZoneSource("manual"); setSaved(false); }
  };

  const handleRestingHR = (val: string) => {
    const n = parseInt(val) || 0;
    setRestingHR(n);
    if (maxHR > n) { setZones(calcZones(maxHR, n)); setZoneSource("manual"); setSaved(false); }
  };

  const handleLthr = (val: string) => {
    const n = parseInt(val) || 0;
    setLthr(n);
    if (n > 0) { setZones(calcZonesFromLthr(n)); setZoneSource("lthr"); setSaved(false); }
  };

  const updateZone = (i: number, field: "min" | "max", val: string) => {
    const n = parseInt(val) || 0;
    setZones(prev => prev.map((z, idx) => idx === i ? { ...z, [field]: n } : z));
    setZoneSource(zoneSource === "lthr" ? "lthr" : "manual");
    setSaved(false);
  };

  const resetToCalc = () => {
    setZones(zoneSource === "lthr" ? calcZonesFromLthr(lthr) : calcZones(maxHR, restingHR));
    setSaved(false);
  };

  async function persistZones(zonesToSave: ZoneRow[], source: "manual" | "lthr" | "garmin" | "strava") {
    const res = await fetch("/api/settings/hr-zones", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxHR, restingHR, lthr, zones: zonesToSave, source }),
    });
    const data = await res.json() as { ok?: boolean; error?: string };
    if (!res.ok) throw new Error(data.error ?? "Failed to save");
  }

  // Pull a 5-zone HR set from Garmin (last activity's device-configured
  // zones) or Strava (account zones) and apply it immediately — picking a
  // source is a complete action (fully replaces the zone set), unlike manual
  // Max/Resting HR edits which stay a draft until "Save zones" is clicked.
  async function fetchZonesFrom(source: "garmin" | "strava") {
    setZoneSourceLoading(true);
    setZoneSourceError(null);
    try {
      const res = await fetch(`/api/settings/hr-zones/external?source=${source}`);
      const d = await res.json() as { zones?: ZoneRow[]; error?: string };
      if (!res.ok || !d.zones) throw new Error(d.error ?? "Failed to fetch zones");
      setZones(d.zones);
      setZoneSource(source);
      await persistZones(d.zones, source);
      setSaved(true);
    } catch (e) {
      setZoneSourceError(e instanceof Error ? e.message : "Failed to fetch zones");
    } finally {
      setZoneSourceLoading(false);
    }
  }

  async function handleZoneSourceChange(source: "manual" | "lthr" | "garmin" | "strava") {
    if (source === "manual" || source === "lthr") {
      const calcZonesForSource = source === "lthr" ? calcZonesFromLthr(lthr) : calcZones(maxHR, restingHR);
      setZones(calcZonesForSource);
      setZoneSource(source);
      setZoneSourceError(null);
      setZoneSourceLoading(true);
      try {
        await persistZones(calcZonesForSource, source);
        setSaved(true);
      } catch (e) {
        setZoneSourceError(e instanceof Error ? e.message : "Failed to save");
      } finally {
        setZoneSourceLoading(false);
      }
    } else {
      fetchZonesFrom(source);
    }
  }

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await persistZones(zones, zoneSource);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  // ── BBC handlers ───────────────────────────────────────────────────────────
  async function saveBbcList(list: BbcProgramme[]) {
    setBbcProgrammes(list);
    await fetch("/api/bbc/programmes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ programmes: list }),
    });
  }

  async function handleBbcBrowserSave(prog: { pid: string; name: string; synopsis?: string }) {
    let updated: BbcProgramme[];
    if (bbcBrowserMode === "replace" && bbcBrowserTargetPid) {
      updated = bbcProgrammes.map(p => p.pid === bbcBrowserTargetPid ? prog : p);
      if (!bbcProgrammes.some(p => p.pid === bbcBrowserTargetPid)) {
        updated = [...bbcProgrammes, prog];
      }
    } else {
      updated = bbcProgrammes.some(p => p.pid === prog.pid)
        ? bbcProgrammes.map(p => p.pid === prog.pid ? prog : p)
        : [...bbcProgrammes, prog];
    }
    await saveBbcList(updated);
    setBbcBrowserOpen(false);
    setBbcSaveMsg("Saved! Returning to dashboard…");
    setTimeout(() => router.push("/dashboard"), 1200);
  }

  async function removeBbcProgramme(pid: string) {
    await saveBbcList(bbcProgrammes.filter(p => p.pid !== pid));
  }

  async function saveRunnaUrl() {
    setRunnaSaving(true);
    setRunnaSaved(false);
    setRunnaError(null);
    try {
      const res = await fetch("/api/settings/runna-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ icsUrl: runnaUrl.trim() }),
      });
      if (!res.ok) throw new Error("Failed to save");
      setRunnaSaved(true);
    } catch {
      setRunnaError("Failed to save — try again.");
    } finally {
      setRunnaSaving(false);
    }
  }

  async function saveNtfyTopic() {
    setNtfySaving(true);
    setNtfySaved(false);
    setNtfyError(null);
    try {
      const res = await fetch("/api/settings/ntfy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: ntfyTopic.trim() }),
      });
      if (!res.ok) throw new Error("Failed to save");
      setNtfySaved(true);
    } catch {
      setNtfyError("Failed to save — try again.");
    } finally {
      setNtfySaving(false);
    }
  }

  async function testNtfyTopic() {
    setNtfyTesting(true);
    setNtfyTestMsg(null);
    setNtfyError(null);
    try {
      const res = await fetch("/api/settings/ntfy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: ntfyTopic.trim() }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Test failed");
      setNtfyTestMsg("Test sent — check your phone.");
    } catch (e) {
      setNtfyError(e instanceof Error ? e.message : "Test failed — try again.");
    } finally {
      setNtfyTesting(false);
    }
  }

  useEffect(() => {
    fetch("/api/local-auth/totp")
      .then(r => r.json())
      .then((d: { enabled?: boolean; secret?: string; qrDataUrl?: string }) => {
        setTotpEnabled(d.enabled ?? false);
        setTotpSecret(d.secret ?? null);
        setTotpQr(d.qrDataUrl ?? null);
      })
      .catch(() => setTotpEnabled(false));
  }, []);

  async function confirmTotp() {
    setTotpBusy(true);
    setTotpError(null);
    setTotpMsg(null);
    try {
      const res = await fetch("/api/local-auth/totp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: totpCode }),
      });
      const d = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !d.ok) throw new Error(d.error ?? "Verification failed");
      setTotpEnabled(true);
      setTotpCode("");
      setTotpMsg("2FA enabled — codes will be required at sign-in from now on.");
    } catch (e) {
      setTotpError(e instanceof Error ? e.message : "Verification failed");
    } finally {
      setTotpBusy(false);
    }
  }

  async function disableTotp() {
    setTotpBusy(true);
    setTotpError(null);
    setTotpMsg(null);
    try {
      const res = await fetch("/api/local-auth/totp", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: totpCode }),
      });
      const d = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !d.ok) throw new Error(d.error ?? "Failed to disable");
      setTotpEnabled(false);
      setTotpCode("");
      setTotpQr(null);
      setTotpSecret(null);
      setTotpMsg("2FA disabled.");
      // Fetch a fresh secret/QR for potential re-enrolment
      const rq = await fetch("/api/local-auth/totp");
      const rd = await rq.json() as { secret?: string; qrDataUrl?: string };
      setTotpSecret(rd.secret ?? null);
      setTotpQr(rd.qrDataUrl ?? null);
    } catch (e) {
      setTotpError(e instanceof Error ? e.message : "Failed to disable");
    } finally {
      setTotpBusy(false);
    }
  }

  // Send a WOL magic packet, then poll the health check until the PC answers
  // (a cold boot can take a minute or two).
  async function wakeAiDjPc() {
    setWaking(true);
    setWakeMsg(null);
    try {
      const res = await fetch("/api/ai-dj/wake", { method: "POST" });
      const d = await res.json() as { error?: string };
      if (!res.ok) throw new Error(d.error ?? "Wake failed");
      setWakeMsg("Magic packet sent — waiting for the PC to come up…");
      if (wakePollRef.current) clearInterval(wakePollRef.current);
      wakePollRef.current = setInterval(() => setAiDjCheckNonce(n => n + 1), 8000);
      setTimeout(() => {
        if (wakePollRef.current) { clearInterval(wakePollRef.current); wakePollRef.current = null; }
        setWaking(w => {
          if (w) setWakeMsg("Still no response after 2 minutes — check the BIOS WOL setting.");
          return false;
        });
      }, 120_000);
    } catch (e) {
      setWakeMsg(e instanceof Error ? e.message : "Wake failed");
      setWaking(false);
    }
  }

  useEffect(() => {
    if (waking && aiDjHealth === "ok") {
      if (wakePollRef.current) { clearInterval(wakePollRef.current); wakePollRef.current = null; }
      setWaking(false);
      setWakeMsg("PC is up.");
    }
  }, [aiDjHealth, waking]);

  async function loadDeletedTracksList() {
    setDeletedTracksLoading(true);
    setDeletedTracksError(null);
    try {
      const res = await fetch("/api/settings/deleted-tracks");
      const d = await res.json() as { tracks?: RejectedTrack[]; error?: string };
      if (!res.ok) throw new Error(d.error ?? "Failed to load");
      setDeletedTracksList(d.tracks ?? []);
    } catch (e) {
      setDeletedTracksError(e instanceof Error ? e.message : "Failed to load deleted tracks");
    } finally {
      setDeletedTracksLoading(false);
    }
  }

  async function forgetDeletedTrack(uri: string) {
    setForgettingUris(prev => new Set(prev).add(uri));
    try {
      const res = await fetch("/api/settings/deleted-tracks", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uris: [uri] }),
      });
      if (!res.ok) throw new Error();
      setDeletedTracksList(prev => prev?.filter(t => t.uri !== uri) ?? prev);
    } catch {
      setDeletedTracksError("Failed to remove — try again.");
    } finally {
      setForgettingUris(prev => { const next = new Set(prev); next.delete(uri); return next; });
    }
  }

  async function saveAiDj(
    enabled: boolean, autoPlaylist: boolean = aiDjAutoPlaylist,
    provider: "local" | "claude" | "gemini" = aiDjProvider,
    claudeModel: string = aiDjClaudeModel, claudeEffort: string = aiDjClaudeEffort,
    geminiModel: string = aiDjGeminiModel,
  ) {
    setAiDjSaving(true);
    setAiDjSaved(false);
    setAiDjError(null);
    try {
      const res = await fetch("/api/settings/ai-dj", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: aiDjUrl.trim(), enabled, autoPlaylist, wolMac: aiDjWolMac.trim(), provider, claudeModel, claudeEffort, geminiModel }),
      });
      if (!res.ok) throw new Error();
      setAiDjEnabled(enabled);
      setAiDjAutoPlaylist(autoPlaylist);
      setAiDjProvider(provider);
      setAiDjClaudeModel(claudeModel);
      setAiDjClaudeEffort(claudeEffort);
      setAiDjGeminiModel(geminiModel);
      setAiDjSaved(true);
    } catch {
      setAiDjError("Failed to save — try again.");
    } finally {
      setAiDjSaving(false);
    }
  }

  async function saveGarminConfig() {
    setGarminSaving(true);
    setGarminSaved(false);
    setGarminError(null);
    try {
      const res = await fetch("/api/settings/garmin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dbPath: garminDbPath.trim() }),
      });
      if (!res.ok) throw new Error("Failed to save");
      setGarminSaved(true);
      setGarminConfigured(true);
    } catch {
      setGarminError("Failed to save — try again.");
    } finally {
      setGarminSaving(false);
    }
  }

  async function removeGarminConfig() {
    await fetch("/api/settings/garmin", { method: "DELETE" });
    setGarminConfigured(false);
    setGarminSaved(false);
  }

  function openBrowser(mode: "add" | "replace", targetPid?: string, targetName?: string) {
    setBbcBrowserMode(mode);
    setBbcBrowserTargetPid(targetPid);
    setBbcBrowserTargetName(targetName);
    setBbcBrowserOpen(true);
    setBbcSaveMsg(null);
  }

  // Browse only stages the file locally — nothing is written to the Pi or
  // Spotify until Save is pressed, so append/overwrite can be picked after
  // seeing the file's track count.
  function handleCsvUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setCsvError(null);
    setCsvSaved(false);
    setCsvStagedText(null);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const lines = text.replace(/\r/g, "").split("\n").filter(Boolean);
      if (lines.length < 2) { setCsvError("File appears to be empty."); return; }
      const header = lines[0].toLowerCase();
      if (!header.includes("track") && !header.includes("name") && !header.includes("uri")) {
        setCsvError("Doesn't look like an Exportify CSV — check the file and try again."); return;
      }
      setCsvFileName(file.name);
      setCsvTrackCount(lines.length - 1);
      setCsvStagedText(text);
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  async function saveCsvToPlaylist(allowDeletedUris?: string[]) {
    const name = csvPlaylistName.trim();
    if (!name) { setCsvError("Enter a playlist name first — this is both its name on Spotify and its filename on the Pi."); return; }
    if (!csvStagedText) return;
    setCsvSaving(true);
    setCsvError(null);
    try {
      await resolvePlaylistByName(name);
      const confirmed = allowDeletedUris !== undefined;
      const res = await fetch(`/api/save-default-playlist?mode=${csvImportMode}${confirmed ? "&confirm=1" : ""}`, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          ...(confirmed ? { "x-allow-deleted-uris": JSON.stringify(allowDeletedUris) } : {}),
        },
        body: csvStagedText,
      });
      const d = await res.json() as { appended?: number; skipped?: number; needsReview?: boolean; rejected?: RejectedTrack[] };
      if (d.needsReview && d.rejected?.length) {
        // Previously-deleted tracks in the upload — nothing written yet;
        // resume re-posts with the user's override choices.
        setDeletedReview({ rejected: d.rejected, resume: (allow) => { setDeletedReview(null); void saveCsvToPlaylist(allow); } });
        return;
      }
      if (csvImportMode === "append" && d.appended !== undefined) setCsvTrackCount(d.appended);
      setCsvSaved(true);
      setCsvStagedText(null);
      loadPlaylistList();
      loadActiveTracks();
      loadCoverage();
    } catch {
      setCsvError("Failed to save — try again.");
    } finally {
      setCsvSaving(false);
    }
  }

  // Appends an Exportify CSV straight to whichever playlist is currently
  // active (per "Select playlist" above) — no name/target picking, unlike
  // the named-playlist import above. Local CSV only, same as that flow
  // (save-default-playlist never touches Spotify itself).
  function handleAppendCsvUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setAppendCsvError(null);
    setAppendCsvSaved(null);
    setAppendCsvStagedText(null);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const lines = text.replace(/\r/g, "").split("\n").filter(Boolean);
      if (lines.length < 2) { setAppendCsvError("File appears to be empty."); return; }
      const header = lines[0].toLowerCase();
      if (!header.includes("track") && !header.includes("name") && !header.includes("uri")) {
        setAppendCsvError("Doesn't look like an Exportify CSV — check the file and try again."); return;
      }
      setAppendCsvFileName(file.name);
      setAppendCsvTrackCount(lines.length - 1);
      setAppendCsvStagedText(text);
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  async function appendCsvToActivePlaylist(allowDeletedUris?: string[]) {
    if (!appendCsvStagedText) return;
    setAppendCsvSaving(true);
    setAppendCsvError(null);
    try {
      const confirmed = allowDeletedUris !== undefined;
      const res = await fetch(`/api/save-default-playlist?mode=append${confirmed ? "&confirm=1" : ""}`, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          ...(confirmed ? { "x-allow-deleted-uris": JSON.stringify(allowDeletedUris) } : {}),
        },
        body: appendCsvStagedText,
      });
      const d = await res.json() as { error?: string; appended?: number; merged?: number; needsReview?: boolean; rejected?: RejectedTrack[] };
      if (!res.ok) throw new Error(d.error ?? "Failed to append");
      if (d.needsReview && d.rejected?.length) {
        setDeletedReview({ rejected: d.rejected, resume: (allow) => { setDeletedReview(null); void appendCsvToActivePlaylist(allow); } });
        return;
      }
      setAppendCsvSaved({ appended: d.appended ?? 0, merged: d.merged ?? 0 });
      setAppendCsvStagedText(null);
      invalidateRunningPlaylistCache();
      loadPlaylistList();
      fetchHealStatus();
      loadActiveTracks();
      loadCoverage();
    } catch (e) {
      setAppendCsvError(e instanceof Error ? e.message : "Failed to append — try again.");
    } finally {
      setAppendCsvSaving(false);
    }
  }

  async function addTracksBrowser(playlistId: string, uris: string[], token: string): Promise<void> {
    const totalChunks = Math.ceil(uris.length / 100);
    for (let i = 0; i < uris.length; i += 100) {
      const chunkNum = i / 100 + 1;
      const body = JSON.stringify({ uris: uris.slice(i, i + 100) });
      // "Failed to fetch" (a network-level failure with no HTTP response at
      // all — dropped connection, brief offline blip) gets one retry before
      // giving up, since a large copy (1000+ tracks -> 10+ sequential
      // requests) has more surface for a transient blip than a single call.
      let lastErr: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/items`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body,
          });
          if (!res.ok) throw new Error(`Spotify ${res.status}: ${await res.text()}`);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          if (attempt === 0) await new Promise(r => setTimeout(r, 1000));
        }
      }
      if (lastErr) {
        const detail = lastErr instanceof Error ? lastErr.message : String(lastErr);
        throw new Error(`Failed adding tracks ${i + 1}-${Math.min(i + 100, uris.length)} of ${uris.length} (batch ${chunkNum}/${totalChunks}): ${detail}`);
      }
    }
  }

  async function runCronNow() {
    setCronRunning(true);
    setCronResults(null);
    setCronSummary(null);
    setCronError(null);
    try {
      const res = await fetch("/api/cron/weekly", { method: "POST" });
      const data = await res.json() as {
        ok?: boolean;
        error?: string;
        programmeResults?: { name: string; matched: number; found: number; error?: string }[];
        totalMatched?: number;
        dedupRemoved?: number;
        dedupRemaining?: number;
      };
      if (!res.ok) {
        setCronError(data.error ?? "Unknown error");
      } else {
        setCronResults(data.programmeResults ?? []);
        setCronSummary({
          totalMatched: data.totalMatched ?? 0,
          dedupRemoved: data.dedupRemoved ?? 0,
          dedupRemaining: data.dedupRemaining ?? 0,
        });
      }
    } catch (e) {
      setCronError(e instanceof Error ? e.message : "Network error");
    } finally {
      setCronRunning(false);
    }
  }

  const hrr = maxHR - restingHR;
  const hrrValid = maxHR > 0 && restingHR > 0 && hrr > 0;

  const TABS = [
    { key: "heart-rate", label: "Heart Rate & Zones" },
    { key: "playlist", label: "Playlist & BPM" },
    { key: "integrations", label: "Integrations & BBC" },
    { key: "notifications", label: "Notifications & 2FA" },
    { key: "deleted-tracks", label: "Deleted Tracks" },
  ] as const;
  type TabKey = typeof TABS[number]["key"];
  const [activeTab, setActiveTab] = useState<TabKey>("heart-rate");

  useEffect(() => {
    if (activeTab === "deleted-tracks" && deletedTracksList === null && !deletedTracksLoading) {
      void loadDeletedTracksList();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  if (loading) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="h-20 rounded-lg bg-slate-900/85 backdrop-blur-sm animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">

    {/* Previously-deleted tracks review — import paused until the user decides */}
    {deletedReview && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4">
        <div className="w-full max-w-lg rounded-xl bg-slate-900 border border-white/10 p-4 space-y-3">
          <h3 className="font-semibold text-sm">Previously deleted tracks in this import</h3>
          <DeletedTracksReview
            tracks={deletedReview.rejected}
            onConfirm={(allow) => deletedReview.resume(allow)}
          />
        </div>
      </div>
    )}

    {/* ── Tab bar ── */}
    <div className="flex flex-wrap gap-1.5 border-b border-white/10 pb-px">
      {TABS.map(t => (
        <button
          key={t.key}
          onClick={() => setActiveTab(t.key)}
          className={`rounded-t-lg px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
            activeTab === t.key
              ? "border-green-500 text-white"
              : "border-transparent text-slate-500 hover:text-slate-300"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>

    {/* ── Tab 1: Heart Rate & Zones ── */}
    <div className={activeTab === "heart-rate" ? "grid grid-cols-1 lg:grid-cols-2 gap-6 items-start" : "hidden"}>
    <div className="space-y-6">

      {/* Max HR / Resting HR */}
      <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 overflow-hidden">
        <div className="px-5 py-4 border-b border-white/10">
          <h2 className="font-semibold text-lg">Heart Rate Settings</h2>
        </div>
        <div className="p-5 space-y-5">
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-slate-300">Zone Source</label>
          <p className="text-xs text-slate-500">
            Manual uses Max/Resting HR below. Garmin/Strava pull that service&apos;s zones directly — still editable after.
          </p>
          <div className="flex gap-1.5">
            {(["manual", "lthr", "garmin", "strava"] as const).map(s => (
              <button
                key={s}
                onClick={() => handleZoneSourceChange(s)}
                disabled={zoneSourceLoading}
                className={`flex-1 rounded-lg border text-xs font-medium px-3 py-2 capitalize transition-colors disabled:opacity-50 ${
                  zoneSource === s
                    ? "bg-green-500/20 border-green-500/40 text-green-300"
                    : "bg-slate-800/60 border-white/10 text-slate-400 hover:text-slate-200"
                }`}
              >
                {zoneSourceLoading && zoneSource !== s ? "…" : s === "lthr" ? "LTHR" : s}
              </button>
            ))}
          </div>
          {zoneSourceError && <p className="text-xs text-red-400">{zoneSourceError}</p>}
        </div>

        {zoneSource === "lthr" ? (
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-slate-300">Lactate Threshold Heart Rate</label>
            <p className="text-xs text-slate-500">
              From a threshold test or your watch&apos;s LTHR estimate. Zones use Garmin&apos;s %LTHR bands
              (Z1 66–75%, Z2 75–82%, Z3 82–91%, Z4 91–99%, Z5 99–107%).
            </p>
            <input
              type="number"
              min={100}
              max={220}
              value={lthr || ""}
              onChange={e => handleLthr(e.target.value)}
              className="w-24 rounded-lg bg-slate-800/60 border border-white/10 text-lg px-3 py-2 text-slate-100 text-center focus:outline-none focus:ring-1 focus:ring-green-500"
            />
          </div>
        ) : (
          <>
            <div className={`space-y-1.5 ${zoneSource !== "manual" ? "opacity-50" : ""}`}>
              <label className="block text-sm font-medium text-slate-300">Max Heart Rate</label>
              <p className="text-xs text-slate-500">Normally measured from a Max HR Stress Test.</p>
              <input
                type="number"
                min={100}
                max={220}
                value={maxHR || ""}
                onChange={e => handleMaxHR(e.target.value)}
                disabled={zoneSource !== "manual"}
                className="w-24 rounded-lg bg-slate-800/60 border border-white/10 text-lg px-3 py-2 text-slate-100 text-center focus:outline-none focus:ring-1 focus:ring-green-500 disabled:opacity-50"
              />
            </div>

            <div className={`space-y-1.5 ${zoneSource !== "manual" ? "opacity-50" : ""}`}>
              <label className="block text-sm font-medium text-slate-300">Resting Heart Rate</label>
              <p className="text-xs text-slate-500">Measure first thing in the morning, standing still.</p>
              <input
                type="number"
                min={30}
                max={100}
                value={restingHR || ""}
                onChange={e => handleRestingHR(e.target.value)}
                disabled={zoneSource !== "manual"}
                className="w-24 rounded-lg bg-slate-800/60 border border-white/10 text-lg px-3 py-2 text-slate-100 text-center focus:outline-none focus:ring-1 focus:ring-green-500 disabled:opacity-50"
              />
            </div>
          </>
        )}

        {(zoneSource === "garmin" || zoneSource === "strava") && (
          <p className="text-xs text-slate-500 italic">
            Zones loaded from {zoneSource === "garmin" ? "Garmin" : "Strava"}. Editing a zone below switches back to manual.
          </p>
        )}

        {hrrValid && zoneSource === "manual" && (
          <div className="rounded-lg bg-slate-800/50 border border-white/5 px-4 py-3 space-y-0.5">
            <p className="text-sm text-slate-400">
              Heart Rate Reserve:{" "}
              <span className="text-white font-bold text-xl">{hrr}</span>
              <span className="ml-1.5 text-xs text-slate-500">bpm</span>
            </p>
            <p className="text-xs text-slate-600">This is how much your heart rate can vary.</p>
          </div>
        )}
        </div>
      </div>

      {/* Zone Summary */}
      {(hrrValid || zoneSource !== "manual") && (
        <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 overflow-hidden">
          <div className="px-4 py-3 border-b border-white/10">
            <h3 className="font-semibold text-slate-300">Zone Summary</h3>
          </div>
          {zones.map((z, i) => (
            <div key={i} className={`flex items-center gap-3 px-4 py-2.5 ${i < 4 ? "border-b border-white/5" : ""}`}>
              <span className={`w-2 h-2 rounded-full shrink-0 ${ZONE_DETAILS[i].color}`} />
              <span className="text-sm text-slate-500 w-8 shrink-0">Z{i + 1}</span>
              <span className="text-sm text-slate-400 w-24 shrink-0">{ZONE_DETAILS[i].name}</span>
              <span className={`text-sm font-mono font-medium ${ZONE_DETAILS[i].colorText}`}>{zoneLabel(z, i)}</span>
            </div>
          ))}
        </div>
      )}

    </div>
    <div className="space-y-6">

      {/* Zone Details & Override */}
      <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <h3 className="font-semibold text-slate-300">Zone Override</h3>
          <button
            onClick={resetToCalc}
            className="text-xs text-slate-500 hover:text-slate-300 underline transition-colors"
          >
            Reset to calculated
          </button>
        </div>
        <div className="p-3 space-y-3">

        {zones.map((z, i) => (
          <div key={i} className={`rounded-xl bg-slate-800/50 border border-white/5 ${ZONE_DETAILS[i].borderColor} overflow-hidden`}>
            <div className="flex items-center gap-2.5 px-4 py-3 border-b border-white/5">
              <span className={`text-xs font-bold rounded px-1.5 py-0.5 ${ZONE_DETAILS[i].color} text-black shrink-0`}>
                Z{i + 1}
              </span>
              <span className="font-semibold text-slate-200">Zone {i + 1} — {ZONE_DETAILS[i].name}</span>
              <span className="ml-auto text-xs text-slate-600 shrink-0">{ZONE_DETAILS[i].pct}</span>
            </div>

            <div className="px-4 pt-3 pb-1 space-y-1.5">
              <p className="text-sm text-slate-400">{ZONE_DETAILS[i].effort}</p>
              <p className="text-xs text-slate-500 italic leading-relaxed">{ZONE_DETAILS[i].feel}</p>
            </div>

            <div className="px-4 py-3 flex items-center gap-3">
              <span className="text-xs text-slate-500 w-20 shrink-0">Override HR</span>
              {i === 0 ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500">below</span>
                  <input
                    type="number"
                    value={z.max || ""}
                    onChange={e => updateZone(i, "max", e.target.value)}
                    className="w-16 rounded bg-slate-800/60 border border-white/10 text-sm px-2 py-1.5 text-slate-100 text-center focus:outline-none focus:ring-1 focus:ring-green-500"
                  />
                  <span className="text-xs text-slate-500">bpm</span>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    value={z.min || ""}
                    onChange={e => updateZone(i, "min", e.target.value)}
                    className="w-16 rounded bg-slate-800/60 border border-white/10 text-sm px-2 py-1.5 text-slate-100 text-center focus:outline-none focus:ring-1 focus:ring-green-500"
                  />
                  <span className="text-xs text-slate-500">–</span>
                  <input
                    type="number"
                    value={z.max || ""}
                    onChange={e => updateZone(i, "max", e.target.value)}
                    className="w-16 rounded bg-slate-800/60 border border-white/10 text-sm px-2 py-1.5 text-slate-100 text-center focus:outline-none focus:ring-1 focus:ring-green-500"
                  />
                  <span className="text-xs text-slate-500">bpm</span>
                </div>
              )}
            </div>
          </div>
        ))}

        {error && <p className="text-sm text-red-400 px-1">{error}</p>}

        <button
          onClick={save}
          disabled={saving || !hrrValid}
          className="rounded-lg bg-green-500 hover:bg-green-400 disabled:opacity-40 text-black font-semibold text-sm px-5 py-2 transition-colors"
        >
          {saving ? "Saving…" : saved ? "Saved!" : "Save zones"}
        </button>
        </div>
      </div>

    </div>
    </div>

    {/* ── Tab 2: Playlist & BPM ── */}
    <div className={activeTab === "playlist" ? "grid grid-cols-1 lg:grid-cols-2 gap-6 items-start" : "hidden"}>
    <div className="space-y-6">

      {/* Playlist Management */}
      <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 overflow-hidden">
        <div className="px-5 py-4 border-b border-white/10">
          <h2 className="font-semibold text-lg">Playlist Management</h2>
        </div>
        <div className="p-5 space-y-4">

        {/* Sync from Spotify: pull in tracks added to the active playlist
            directly in Spotify (outside the app) and BPM-enrich them. */}
        <div className="rounded-lg bg-slate-800/40 border border-white/10 p-3 space-y-2">
          <p className="text-sm text-slate-400">
            Added tracks to the playlist directly in Spotify? Sync them into the local BPM library.
          </p>
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={syncFromSpotify}
              disabled={syncingFromSpotify || !activePlaylistId}
              className="inline-flex items-center gap-2 rounded-lg bg-green-500 hover:bg-green-400 disabled:opacity-40 text-black font-semibold text-xs px-3 py-1.5 transition-colors whitespace-nowrap"
            >
              {syncingFromSpotify ? "Syncing…" : "Sync from Spotify"}
            </button>
            {syncMsg && <span className="text-sm text-green-400">{syncMsg}</span>}
          </div>
          {syncError && <p className="text-sm text-red-400">{syncError}</p>}
        </div>

        <p className="text-sm text-slate-400">
          Export your Spotify playlist via{" "}
          <a href="https://exportify.net" target="_blank" rel="noopener noreferrer"
            className="text-green-400 hover:text-green-300 underline">
            exportify.net
          </a>
          , then upload the CSV here.
        </p>
        <ol className="text-xs text-slate-500 space-y-1 list-decimal list-inside">
          <li>Go to <span className="text-slate-300">exportify.net</span> and log in with Spotify</li>
          <li>Find your playlist and click <span className="text-slate-300">Export</span></li>
          <li>Name it below, then browse to the downloaded CSV</li>
        </ol>
        <div className="space-y-2">
          <input
            type="text"
            value={csvPlaylistName}
            onChange={e => { setCsvPlaylistName(e.target.value); setCsvError(null); }}
            placeholder="Playlist name (Spotify name + Pi filename)"
            className="w-full rounded-lg bg-slate-800/60 border border-white/10 text-sm px-3 py-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-green-500"
          />
          <div className="flex items-center gap-3 flex-wrap">
            <input ref={csvFileRef} type="file" accept=".csv" onChange={handleCsvUpload} className="hidden" />
            <button
              onClick={() => csvFileRef.current?.click()}
              disabled={csvSaving}
              className="inline-flex items-center gap-2 rounded-lg bg-slate-700/80 hover:bg-slate-600/80 disabled:opacity-40 text-slate-200 text-sm font-medium px-4 py-2 transition-colors"
            >
              Browse CSV
            </button>
            {csvSaved && csvFileName && (
              <span className="text-sm text-green-400">
                {csvFileName} saved to "{csvPlaylistName}" — {csvTrackCount} tracks{csvImportMode === "append" ? " added" : ""}
              </span>
            )}
          </div>

          {/* Nothing is written to the Pi or Spotify until Save is pressed here —
              pick append/overwrite after seeing the file's track count */}
          {csvStagedText && (
            <div className="rounded-lg bg-slate-800/40 border border-white/10 p-3 space-y-2">
              <p className="text-xs text-slate-400">
                {csvFileName} — {csvTrackCount} tracks
              </p>
              <div className="flex items-center gap-3 flex-wrap">
                <div className="inline-flex rounded-lg border border-white/10 overflow-hidden text-xs">
                  <button
                    onClick={() => setCsvImportMode("overwrite")}
                    className={`px-3 py-1.5 transition-colors ${csvImportMode === "overwrite" ? "bg-slate-600 text-white" : "bg-slate-800/60 text-slate-400 hover:text-slate-200"}`}
                  >
                    Overwrite
                  </button>
                  <button
                    onClick={() => setCsvImportMode("append")}
                    className={`px-3 py-1.5 transition-colors ${csvImportMode === "append" ? "bg-slate-600 text-white" : "bg-slate-800/60 text-slate-400 hover:text-slate-200"}`}
                  >
                    Append
                  </button>
                </div>
                <button
                  onClick={() => saveCsvToPlaylist()}
                  disabled={csvSaving || !csvPlaylistName.trim()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-green-500 hover:bg-green-400 disabled:opacity-40 text-black font-semibold text-xs px-3 py-1.5 transition-colors whitespace-nowrap"
                >
                  {csvSaving ? "Saving…" : csvImportMode === "overwrite" ? `Overwrite "${csvPlaylistName || "…"}"` : `Add to "${csvPlaylistName || "…"}"`}
                </button>
              </div>
            </div>
          )}
        </div>
        {csvError && <p className="text-sm text-red-400">{csvError}</p>}

        {/* Select Playlist — switch/delete, always visible so it's discoverable
            even when only one playlist has ever been configured */}
        <div className="pt-3 border-t border-white/10 space-y-2">
          <label className="block text-sm font-medium text-slate-300">Select playlist</label>
          <p className="text-xs text-slate-500">
            Switch which playlist is active, or delete one you no longer need (locally, with an
            option to also unfollow it on Spotify).
          </p>
          {!playlistsLoaded ? (
            <p className="text-xs text-slate-500 italic">Loading…</p>
          ) : knownPlaylists.length === 0 ? (
            <p className="text-xs text-slate-500 italic">No playlists yet — import one below.</p>
          ) : (
            <div className="space-y-1.5">
              {knownPlaylists.map(p => (
                <div
                  key={p.id}
                  className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 ${
                    p.id === activePlaylistId ? "border-green-500/40 bg-green-500/5" : "border-white/10 bg-slate-800/40"
                  }`}
                >
                  <div className="min-w-0">
                    <p className="text-sm text-slate-200 truncate">
                      {p.name}
                      {typeof p.trackCount === "number" && (
                        <span className="ml-2 text-xs text-slate-500">{p.trackCount} track{p.trackCount === 1 ? "" : "s"}</span>
                      )}
                      {p.id === activePlaylistId && <span className="ml-2 text-xs text-green-400">active</span>}
                    </p>
                    <p className="text-xs text-slate-500 font-mono truncate">{p.csvFile}</p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {p.id !== activePlaylistId && (
                      <button
                        onClick={() => switchActivePlaylist(p.id)}
                        disabled={switchingId === p.id}
                        className="text-xs rounded-lg bg-slate-700/80 hover:bg-slate-600/80 disabled:opacity-40 text-slate-200 px-2.5 py-1 transition-colors"
                      >
                        {switchingId === p.id ? "Switching…" : "Use"}
                      </button>
                    )}
                    <a
                      href={`/api/settings/playlists/download?id=${encodeURIComponent(p.id)}`}
                      className="p-1.5 text-slate-500 hover:text-green-400 transition-colors rounded"
                      title={`Download ${p.csvFile}`}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                        <path d="M10.75 2.75a.75.75 0 00-1.5 0v8.614L6.295 8.235a.75.75 0 10-1.09 1.03l4.25 4.5a.75.75 0 001.09 0l4.25-4.5a.75.75 0 00-1.09-1.03l-2.955 3.129V2.75z" />
                        <path d="M3.5 12.75a.75.75 0 00-1.5 0v2.5A2.75 2.75 0 004.75 18h10.5A2.75 2.75 0 0018 15.25v-2.5a.75.75 0 00-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5z" />
                      </svg>
                    </a>
                    {p.id === activePlaylistId && (
                      <button
                        onClick={healNow}
                        disabled={!!healProgress?.running}
                        title="Check for missing BPM/duration/audio-feature data and try to fill the gaps"
                        className="text-xs rounded-lg border border-white/10 bg-slate-800/60 hover:bg-slate-700/60 disabled:opacity-40 disabled:cursor-not-allowed text-slate-300 px-2.5 py-1 transition-colors whitespace-nowrap"
                      >
                        {healProgress?.running ? "Checking…" : "Check for missing data"}
                      </button>
                    )}
                    <button
                      onClick={() => { setDeleteTarget(p); setDeleteUnfollow(true); }}
                      className="p-1.5 text-slate-500 hover:text-red-400 transition-colors rounded"
                      title="Delete this playlist"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                        <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clipRule="evenodd" />
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {playlistListError && <p className="text-xs text-red-400">{playlistListError}</p>}

          {/* CSV heal-sweep status — backfills BPM/audio-feature/genre data
              after a save/import or "Check for missing data" above; can run
              for a long time on a large library, so this keeps it visible
              instead of the page looking like nothing happened. */}
          {healStatus && (
            <div className="rounded-lg bg-slate-800/40 border border-white/10 p-3 space-y-1.5">
              <p className="text-sm font-medium text-slate-200">{healStatus.total} tracks</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
                {healStatus.missingUri > 0 && <span className="text-red-400">{healStatus.missingUri} missing Spotify URI</span>}
                {healStatus.missingDuration > 0 && <span>{healStatus.missingDuration} missing duration</span>}
                {healStatus.missingGenres > 0 && <span>{healStatus.missingGenres} missing genres</span>}
                {Object.entries(healStatus.missingFeatures).filter(([, n]) => n > 0).map(([field, n]) => (
                  <span key={field}>{n} missing {field.toLowerCase()}</span>
                ))}
                {healStatus.missingDuration === 0 && healStatus.missingGenres === 0
                  && healStatus.missingUri === 0
                  && Object.values(healStatus.missingFeatures).every(n => n === 0) && (
                  <span className="text-green-400">Nothing missing 🎉</span>
                )}
              </div>
              <p className="text-xs">
                {healProgress?.spotifyRetryAt && new Date(healProgress.spotifyRetryAt).getTime() > Date.now() ? (
                  <span className="text-amber-400">
                    ⚠ Spotify rate limit active — clears {new Date(healProgress.spotifyRetryAt).toLocaleTimeString()}
                  </span>
                ) : (
                  <span className="text-slate-600">Spotify rate limit: not active</span>
                )}
              </p>
            </div>
          )}

          {healProgress?.running && (
            <div className="rounded-lg bg-purple-500/10 border border-purple-500/30 p-3 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium text-purple-300">
                  Backfilling {healProgress.phase === "uris" ? "missing Spotify URIs" : healProgress.phase === "features" ? "BPM/audio features" : healProgress.phase === "genres" ? "genres" : "track durations"}…
                </p>
                <span className="text-xs text-purple-300/70 tabular-nums">
                  {healProgress.current}/{healProgress.total}
                </span>
              </div>
              <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-purple-400 rounded-full transition-all duration-300"
                  style={{ width: `${healProgress.total > 0 ? Math.round((healProgress.current / healProgress.total) * 100) : 0}%` }}
                />
              </div>
              <p className="text-xs text-slate-500">
                {healProgress.healedSoFar} row{healProgress.healedSoFar === 1 ? "" : "s"} healed so far
                {healProgress.phase === "duration" && " — BPM data is already in, this pass only fills track durations"}
                {healProgress.phase === "genres" && " — duration/BPM data is already in, this pass only fills genres"}
              </p>
              {healProgress.spotifyRetryAt && new Date(healProgress.spotifyRetryAt).getTime() > Date.now() && (
                <p className="text-xs text-amber-400">
                  ⚠ Spotify rate-limited — expires {new Date(healProgress.spotifyRetryAt).toLocaleTimeString()}, continuing with Deezer/Last.fm only
                </p>
              )}
            </div>
          )}

          {healProgress?.log && healProgress.log.length > 0 && (
            <div className="rounded-lg bg-slate-950/60 border border-white/10 overflow-hidden">
              <div className="px-3 py-1.5 border-b border-white/10">
                <p className="text-xs font-medium text-slate-400">Heal log</p>
              </div>
              <div className="max-h-40 overflow-y-auto p-3 space-y-1 font-mono text-xs">
                {[...healProgress.log].reverse().map((entry, i) => (
                  <p key={i} className="text-slate-500">
                    <span className="text-slate-600">{new Date(entry.at).toLocaleTimeString()}</span>{" "}
                    <span className={/rate-limited/i.test(entry.text) ? "text-amber-400" : "text-slate-400"}>{entry.text}</span>
                  </p>
                ))}
              </div>
            </div>
          )}
          {healNowError && <p className="text-xs text-red-400">{healNowError}</p>}
        </div>

        {/* Append CSV to the currently active playlist — no name/target
            picking, unlike the named-playlist import above. Local library
            CSV only, same as that flow (never writes to Spotify itself). */}
        <div className="pt-3 border-t border-white/10 space-y-2">
          <label className="block text-sm font-medium text-slate-300">Append CSV to active playlist</label>
          <p className="text-xs text-slate-500">
            Upload an Exportify CSV and add its tracks to{" "}
            <span className="text-slate-300">
              {knownPlaylists.find(p => p.id === activePlaylistId)?.name ?? "the active playlist"}
            </span>
            {" "}— new tracks are added; tracks already there get any blank fields (e.g. BPM) filled in from this file, never overwritten.
          </p>
          <div className="flex items-center gap-3 flex-wrap">
            <input ref={appendCsvFileRef} type="file" accept=".csv" onChange={handleAppendCsvUpload} className="hidden" />
            <button
              onClick={() => appendCsvFileRef.current?.click()}
              disabled={appendCsvSaving}
              className="inline-flex items-center gap-2 rounded-lg bg-slate-700/80 hover:bg-slate-600/80 disabled:opacity-40 text-slate-200 text-sm font-medium px-4 py-2 transition-colors"
            >
              Browse CSV
            </button>
            {appendCsvSaved !== null && (
              <span className="text-sm text-green-400">
                {appendCsvFileName} — {appendCsvSaved.appended} track{appendCsvSaved.appended === 1 ? "" : "s"} added
                {appendCsvSaved.merged > 0 && ` · ${appendCsvSaved.merged} existing track${appendCsvSaved.merged === 1 ? "" : "s"} filled in`}
              </span>
            )}
          </div>

          {appendCsvStagedText && (
            <div className="rounded-lg bg-slate-800/40 border border-white/10 p-3 flex items-center justify-between gap-3 flex-wrap">
              <p className="text-xs text-slate-400">
                {appendCsvFileName} — {appendCsvTrackCount} tracks
              </p>
              <button
                onClick={() => appendCsvToActivePlaylist()}
                disabled={appendCsvSaving}
                className="inline-flex items-center gap-1.5 rounded-lg bg-green-500 hover:bg-green-400 disabled:opacity-40 text-black font-semibold text-xs px-3 py-1.5 transition-colors whitespace-nowrap"
              >
                {appendCsvSaving ? "Adding…" : "Add to active playlist"}
              </button>
            </div>
          )}
          {appendCsvError && <p className="text-xs text-red-400">{appendCsvError}</p>}
        </div>

        </div>
      </div>

    </div>
    <div className="space-y-6">

      {/* Run-type BPM limits — feeds the AI DJ mixer's per-segment LLM
          prompts (ai_dj/workout.py's _kind_bpm_bounds) and the Library
          Coverage report below, so it lives alongside both on this tab. */}
      <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5 space-y-4">
        <div>
          <h3 className="font-semibold text-slate-200">Run BPM limits</h3>
          <p className="text-sm text-slate-400 mt-1">
            Min/max music BPM per run type for AI DJ mixes. Leave blank for automatic
            cadence matching — anything set here becomes a hard limit.
            Half-time tracks count at double tempo (an 87 BPM track counts as 174).
          </p>
        </div>
        <div className="space-y-2">
          {([
            ["warmup", "Warm up"],
            ["work", "Work / intervals"],
            ["easy", "Easy / conversational"],
            ["cooldown", "Cool down"],
            ["rest", "Rest / recovery"],
          ] as [string, string][]).map(([kind, label]) => {
            const minVal = bpmOv[kind].min.trim();
            const maxVal = bpmOv[kind].max.trim();
            const min = minVal ? Number(minVal) : null;
            const max = maxVal ? Number(maxVal) : null;
            // A range this narrow (or inverted) will silently exclude
            // almost every track — the segment just gets skipped with no
            // error, which is exactly how a min===max typo went unnoticed
            // before (a cooldown segment vanished from a mix entirely).
            const isExact = min !== null && max !== null && min === max;
            const isInverted = min !== null && max !== null && min > max;
            // How many library tracks actually fall in this range right
            // now — same doubletime convention as everywhere else (a
            // sub-95 BPM track counts at double), computed live as the
            // fields are edited so a bad range's impact is visible before
            // saving, not just after a mix silently comes up short.
            const matchCount = !isInverted && activeTracksLoaded
              ? activeTracks.filter(t => {
                  const eff = t.bpm < 95 ? t.bpm * 2 : t.bpm;
                  return (min === null || eff >= min) && (max === null || eff <= max);
                }).length
              : null;
            return (
              <div key={kind}>
                <div className="flex items-center gap-3">
                  <span className="text-sm text-slate-300 w-44 shrink-0">{label}</span>
                  <input
                    type="number"
                    min={0}
                    value={bpmOv[kind].min}
                    onChange={e => { setBpmOv(o => ({ ...o, [kind]: { ...o[kind], min: e.target.value } })); setBpmOvSaved(false); }}
                    placeholder="164"
                    className={`w-24 rounded-lg bg-slate-800/60 border text-sm px-3 py-1.5 text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-green-500 ${
                      isExact || isInverted ? "border-amber-500/50" : "border-white/10"
                    }`}
                  />
                  <span className="text-slate-600 text-xs">–</span>
                  <input
                    type="number"
                    min={0}
                    value={bpmOv[kind].max}
                    onChange={e => { setBpmOv(o => ({ ...o, [kind]: { ...o[kind], max: e.target.value } })); setBpmOvSaved(false); }}
                    placeholder="180"
                    className={`w-24 rounded-lg bg-slate-800/60 border text-sm px-3 py-1.5 text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-green-500 ${
                      isExact || isInverted ? "border-amber-500/50" : "border-white/10"
                    }`}
                  />
                  <span className="text-xs text-slate-600">BPM</span>
                  <span className={`text-xs ml-1 ${matchCount === 0 ? "text-amber-400/90" : "text-slate-500"}`}>
                    {matchCount === null ? "" : `${matchCount} track${matchCount === 1 ? "" : "s"}`}
                  </span>
                </div>
                {isInverted && (
                  <p className="text-xs text-amber-400/90 pl-1 mt-0.5">
                    ⚠ Min is higher than max — no track can ever match; this segment will be skipped.
                  </p>
                )}
                {isExact && (
                  <p className="text-xs text-amber-400/90 pl-1 mt-0.5">
                    ⚠ Min equals max — only a track at exactly {min} BPM qualifies. If none exist in the
                    library, this segment gets silently skipped. Use a real range instead.
                  </p>
                )}
              </div>
            );
          })}
        </div>
        {bpmOvError && <p className="text-sm text-red-400">{bpmOvError}</p>}
        <button
          onClick={saveBpmOverrides}
          disabled={bpmOvSaving}
          className="rounded-lg bg-slate-700/80 hover:bg-slate-600/80 disabled:opacity-40 text-slate-200 font-medium text-sm px-5 py-2 transition-colors"
        >
          {bpmOvSaving ? "Saving…" : bpmOvSaved ? "Saved!" : "Save BPM limits"}
        </button>
      </div>

      {/* Library coverage: tracks the AI DJ mixer could actually be
          presented with (per-kind BPM ceilings from Settings), vs. tracks
          sitting outside every kind's range as dead weight — plus how many
          confirmed mixes each track has played in, so an in-range track
          that's never been picked is visible too. */}
      <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 overflow-hidden">
        <div className="px-5 py-4 border-b border-white/10">
          <h2 className="font-semibold text-lg">Library Coverage — tracks presentable to the AI DJ</h2>
        </div>
        <div className="p-5 space-y-3">
          {!coverageLoaded ? (
            <p className="text-xs text-slate-500 italic">Loading…</p>
          ) : !coverage || coverage.totalTracks === 0 ? (
            <p className="text-xs text-slate-500 italic">No BPM data in the active library yet.</p>
          ) : (
            <>
              <p className="text-xs text-slate-500">
                Effective BPM (half-tempo tracks counted at double) against each run type&apos;s BPM ceiling
                (Settings → Run BPM limits) — a track outside every type&apos;s range can never be picked for any mix.
                Click a BPM row to see its tracks and play counts.
              </p>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-slate-800/60 border border-white/10 px-2 py-2">
                  <p className="text-lg font-semibold text-slate-200">{coverage.totalTracks}</p>
                  <p className="text-[10px] text-slate-500 uppercase tracking-wide">Total</p>
                </div>
                <div className="rounded-lg bg-green-500/10 border border-green-500/20 px-2 py-2">
                  <p className="text-lg font-semibold text-green-400">{coverage.inRangeTracks}</p>
                  <p className="text-[10px] text-slate-500 uppercase tracking-wide">Presentable</p>
                </div>
                <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-2 py-2 space-y-1">
                  <p className="text-lg font-semibold text-red-400">{coverage.outOfRangeTracks}</p>
                  <p className="text-[10px] text-slate-500 uppercase tracking-wide">Never usable</p>
                  {coverage.outOfRangeTracks > 0 && (
                    <button
                      onClick={deleteNeverUsableTracks}
                      disabled={coverageDeleting}
                      className={`w-full rounded text-[10px] font-medium px-1.5 py-1 transition-colors disabled:opacity-40 ${
                        coverageDeleteConfirm
                          ? "bg-red-500 text-white hover:bg-red-400"
                          : "bg-red-500/20 text-red-300 hover:bg-red-500/30"
                      }`}
                    >
                      {coverageDeleting ? "Deleting…" : coverageDeleteConfirm ? "Confirm delete?" : "Delete all"}
                    </button>
                  )}
                </div>
              </div>
              {coverageDeleteMsg && <p className="text-xs text-green-400">{coverageDeleteMsg}</p>}
              {coverageDeleteError && <p className="text-xs text-red-400">{coverageDeleteError}</p>}

              <div className="rounded-lg border border-white/10 divide-y divide-white/5 font-mono text-xs max-h-80 overflow-y-auto no-scrollbar">
                {coverage.buckets.map(b => {
                  // Filtered per-track, not by the bucket's own inRange flag
                  // — a bucket straddling a kind's exact BPM ceiling can mix
                  // in-range and out-of-range tracks, so counts/plays shown
                  // here (and what Copy sends) must only ever reflect the
                  // tracks that are individually actually in range.
                  const presentable = b.tracks.filter(t => t.inRange);
                  if (presentable.length === 0) return null;
                  const isOpen = expandedBucket === b.bpm;
                  const playedSum = presentable.reduce((sum, t) => sum + t.played, 0);
                  return (
                    <div key={b.bpm}>
                      <button
                        onClick={() => setExpandedBucket(isOpen ? null : b.bpm)}
                        className="w-full px-2.5 py-1 flex items-center justify-between gap-3 text-left hover:bg-slate-800/40 transition-colors"
                      >
                        <span className="text-slate-400">{b.bpm} BPM</span>
                        <span className="flex items-center gap-3">
                          <span className="text-slate-200">{presentable.length} track{presentable.length === 1 ? "" : "s"}</span>
                          <span className={playedSum > 0 ? "text-purple-300" : "text-slate-600"}>
                            {playedSum} play{playedSum === 1 ? "" : "s"}
                          </span>
                        </span>
                      </button>
                      {isOpen && (
                        <div className="bg-slate-950/40 divide-y divide-white/5">
                          {presentable.map(t => (
                            <div key={t.uri} className="px-4 py-1 flex items-center justify-between gap-3 text-[11px]">
                              <span className="text-slate-300 truncate">{t.name} — <span className="text-slate-500">{t.artist}</span></span>
                              <span className={t.played > 0 ? "text-purple-300 shrink-0" : "text-slate-600 shrink-0"}>
                                {t.played} play{t.played === 1 ? "" : "s"}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="text-[10px] text-slate-600">
                Plays = confirmed &quot;Today&apos;s Run&quot; mixes each track has featured in, historically — a track&apos;s
                measured BPM can change after it was played (re-sync, corrected match), so a play count doesn&apos;t
                guarantee the track is still in range today.
              </p>

              {/* Copy every presentable (in-range) track to another playlist
                  — an existing known playlist (append + dedupe) or a new
                  one (created on Spotify, registered locally with its own
                  CSV seeded from the active library's data). */}
              <div className="pt-2 border-t border-white/10 space-y-2">
                <label className="block text-xs font-medium text-slate-400">
                  Copy all {coverage.inRangeTracks} presentable tracks to…
                </label>
                <div className="flex items-center gap-2 flex-wrap">
                  <select
                    value={coverageCopyTarget}
                    onChange={e => { setCoverageCopyTarget(e.target.value); setCoverageCopyError(null); }}
                    className="rounded-lg bg-slate-800/60 border border-white/10 text-sm px-3 py-2 text-slate-100 focus:outline-none focus:ring-1 focus:ring-green-500"
                  >
                    <option value="">Choose target playlist…</option>
                    <option value="__new__">+ New playlist…</option>
                    {knownPlaylists.filter(p => p.id !== activePlaylistId).map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                  {coverageCopyTarget === "__new__" && (
                    <input
                      type="text"
                      value={coverageNewPlaylistName}
                      onChange={e => { setCoverageNewPlaylistName(e.target.value); setCoverageCopyError(null); }}
                      placeholder="New playlist name"
                      className="rounded-lg bg-slate-800/60 border border-white/10 text-sm px-3 py-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-green-500"
                    />
                  )}
                  <button
                    onClick={copyCoverageTracksToPlaylist}
                    disabled={coverageCopying || !coverageCopyTarget || (coverageCopyTarget === "__new__" && !coverageNewPlaylistName.trim())}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-green-500 hover:bg-green-400 disabled:opacity-40 text-black font-semibold text-xs px-3 py-2 transition-colors whitespace-nowrap"
                  >
                    {coverageCopying ? "Copying…" : `Copy ${coverage.inRangeTracks} tracks`}
                  </button>
                </div>
                {coverageCopyMsg && <p className="text-xs text-green-400">{coverageCopyMsg}</p>}
                {coverageCopyError && <p className="text-xs text-red-400">{coverageCopyError}</p>}
              </div>
            </>
          )}
        </div>
      </div>

      <DedupCard />

    </div>
    </div>

    {/* ── Tab 3: Integrations & BBC ── */}
    <div className={activeTab === "integrations" ? "grid grid-cols-1 lg:grid-cols-2 gap-6 items-start" : "hidden"}>
    <div className="space-y-6">

      {/* BBC Programme list */}
      <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <h2 className="font-semibold text-lg">BBC Programmes</h2>
          {!bbcBrowserOpen && (
            <button
              onClick={() => openBrowser("add")}
              className="text-xs text-slate-400 hover:text-slate-200 border border-white/10 rounded-lg px-3 py-1.5 transition-colors"
            >
              + Add Programme
            </button>
          )}
        </div>
        <div className="p-5 space-y-4">

        {bbcLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map(i => <div key={i} className="h-14 rounded-lg bg-slate-800/50 animate-pulse" />)}
          </div>
        ) : bbcProgrammes.length === 0 ? (
          <p className="text-sm text-slate-500">No BBC programmes configured.</p>
        ) : (
          <div className="space-y-2 overflow-y-auto no-scrollbar max-h-[320px]">
            {bbcProgrammes.map(p => (
              <div key={p.pid} className="flex items-center justify-between gap-2 rounded-lg bg-slate-800/50 border border-white/5 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-200 truncate">{p.name}</p>
                  <p className="text-xs text-slate-500 font-mono">{p.pid}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => openBrowser("replace", p.pid, p.name)}
                    className="p-1.5 text-slate-500 hover:text-slate-300 transition-colors rounded"
                    title="Change programme"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                      <path d="M2.695 14.763l-1.262 3.154a.5.5 0 00.65.65l3.155-1.262a4 4 0 001.343-.885L17.5 5.5a2.121 2.121 0 00-3-3L3.58 13.42a4 4 0 00-.885 1.343z" />
                    </svg>
                  </button>
                  <button
                    onClick={() => removeBbcProgramme(p.pid)}
                    className="p-1.5 text-slate-600 hover:text-red-400 transition-colors rounded"
                    title="Remove"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                      <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {bbcSaveMsg && <p className="text-sm text-green-400">{bbcSaveMsg}</p>}

        {/* Run Now */}
        {!bbcBrowserOpen && (
          <div className="space-y-3 pt-1">
            <button
              onClick={runCronNow}
              disabled={cronRunning || bbcLoading}
              className="w-full rounded-lg bg-slate-800/60 hover:bg-slate-700/60 disabled:opacity-40 border border-white/10 text-sm font-medium text-slate-200 px-4 py-2.5 transition-colors flex items-center justify-center gap-2"
            >
              {cronRunning ? (
                <>
                  <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                  </svg>
                  Running… this may take a minute
                </>
              ) : (
                <>
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                    <path fillRule="evenodd" d="M2 10a8 8 0 1116 0 8 8 0 01-16 0zm6.39-2.908a.75.75 0 01.766.027l3.5 2.25a.75.75 0 010 1.262l-3.5 2.25A.75.75 0 018 12.25v-4.5a.75.75 0 01.39-.658z" clipRule="evenodd" />
                  </svg>
                  Run playlist update now
                </>
              )}
            </button>

            {cronError && <p className="text-sm text-red-400">{cronError}</p>}

            {cronResults && cronSummary && (
              <div className="rounded-lg bg-slate-800/50 border border-white/5 overflow-hidden text-sm">
                {cronResults.map((r, i) => (
                  <div key={i} className={`flex items-center justify-between gap-3 px-4 py-2.5 ${i < cronResults.length - 1 ? "border-b border-white/5" : ""}`}>
                    <span className={`truncate ${r.error ? "text-red-400" : "text-slate-300"}`}>{r.name}</span>
                    {r.error ? (
                      <span className="text-xs text-red-500 shrink-0">{r.error}</span>
                    ) : (
                      <span className="text-xs text-slate-500 shrink-0 tabular-nums">{r.matched} / {r.found} songs added</span>
                    )}
                  </div>
                ))}
                <div className="px-4 py-2.5 bg-slate-800/50 border-t border-white/5 flex items-center justify-between">
                  <span className="text-slate-400 font-medium">{cronSummary.totalMatched} songs added total</span>
                  <span className="text-xs text-slate-500 tabular-nums">
                    {cronSummary.dedupRemoved > 0
                      ? `${cronSummary.dedupRemoved} dupes removed · ${cronSummary.dedupRemaining} in playlist`
                      : `${cronSummary.dedupRemaining} tracks in playlist`}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}

        {bbcBrowserOpen && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm text-slate-400">
                {bbcBrowserMode === "replace" && bbcBrowserTargetName
                  ? `Replacing: ${bbcBrowserTargetName}`
                  : "Select a BBC programme to add"}
              </p>
              <button
                onClick={() => setBbcBrowserOpen(false)}
                className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
              >
                Cancel
              </button>
            </div>
            <BbcBrowserCard
              onAdd={handleBbcBrowserSave}
              defaultOpen={true}
              saveLabel={bbcBrowserMode === "replace" ? "Replace BBC Source" : "Add to BBC Sources"}
            />
          </div>
        )}
        </div>
      </div>

      {/* AI DJ */}
      <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold text-base">🎧 AI DJ</h2>
            <p className="text-sm text-slate-400 mt-1">
              Adds an <span className="text-purple-300">AI DJ Mix</span> button to each Runna workout that
              builds a pace-matched Spotify playlist from your library, section by section.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={aiDjEnabled}
            onClick={() => { if (!aiDjSaving && (aiDjProvider !== "local" || aiDjUrl.trim())) saveAiDj(!aiDjEnabled); }}
            disabled={aiDjSaving || (aiDjProvider === "local" && !aiDjUrl.trim())}
            className={`relative shrink-0 w-11 h-6 rounded-full transition-colors disabled:opacity-40 ${
              aiDjEnabled ? "bg-purple-500" : "bg-slate-700"
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                aiDjEnabled ? "translate-x-5" : "translate-x-0"
              }`}
            />
          </button>
        </div>
        {aiDjEnabled && (
          <div className="flex items-center gap-2 text-sm text-purple-300">
            <span>●</span>
            <span>Enabled — mix buttons shown on workouts</span>
          </div>
        )}
        {aiDjEnabled && (
          <div className="flex items-start justify-between gap-3 rounded-lg bg-slate-800/40 border border-white/5 px-3 py-2.5">
            <div>
              <p className="text-sm font-medium text-slate-300">Auto playlist upload</p>
              <p className="text-xs text-slate-500 mt-0.5">
                Daily at 15:30, if a run is scheduled for tomorrow, build its mix and save it to
                &quot;{"Today's Run"}&quot; on Spotify automatically.
              </p>
            </div>
            <button
              role="switch"
              aria-checked={aiDjAutoPlaylist}
              onClick={() => { if (!aiDjSaving) saveAiDj(aiDjEnabled, !aiDjAutoPlaylist); }}
              disabled={aiDjSaving}
              className={`relative shrink-0 w-11 h-6 rounded-full transition-colors disabled:opacity-40 ${
                aiDjAutoPlaylist ? "bg-purple-500" : "bg-slate-700"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                  aiDjAutoPlaylist ? "translate-x-5" : "translate-x-0"
                }`}
              />
            </button>
          </div>
        )}

        {aiDjEnabled && (
          <div className="space-y-3 rounded-lg bg-slate-800/40 border border-white/5 px-3 py-2.5">
            <div>
              <p className="text-sm font-medium text-slate-300">Setlist model</p>
              <p className="text-xs text-slate-500 mt-0.5">
                Which model picks and orders tracks for each workout segment. Runs on the AI DJ service host either way.
              </p>
            </div>
            <div className="flex gap-1.5">
              {([["local", "Local LLM"], ["claude", "Claude"], ["gemini", "Gemini"]] as const).map(([p, label]) => (
                <button
                  key={p}
                  onClick={() => { if (!aiDjSaving) saveAiDj(aiDjEnabled, aiDjAutoPlaylist, p); }}
                  disabled={aiDjSaving}
                  className={`flex-1 rounded-lg border text-xs font-medium px-3 py-2 transition-colors disabled:opacity-50 ${
                    aiDjProvider === p
                      ? "bg-purple-500/20 border-purple-500/40 text-purple-300"
                      : "bg-slate-800/60 border-white/10 text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {aiDjProvider === "claude" && (
              <div className="space-y-3 pt-1">
                <div className="grid sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="text-xs text-slate-400">Model</label>
                    <select
                      value={aiDjClaudeModel}
                      onChange={e => saveAiDj(aiDjEnabled, aiDjAutoPlaylist, "claude", e.target.value, aiDjClaudeEffort)}
                      disabled={aiDjSaving}
                      className="w-full rounded-lg bg-slate-800 border border-slate-700 text-sm px-3 py-2 text-slate-100 disabled:opacity-40 focus:outline-none focus:ring-1 focus:ring-purple-500"
                    >
                      <option value="claude-sonnet-5">Sonnet 5</option>
                      <option value="claude-opus-4-8">Opus 4.8</option>
                      <option value="claude-haiku-4-5">Haiku 4.5</option>
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs text-slate-400">Effort</label>
                    <select
                      value={aiDjClaudeEffort}
                      onChange={e => saveAiDj(aiDjEnabled, aiDjAutoPlaylist, "claude", aiDjClaudeModel, e.target.value)}
                      disabled={aiDjSaving}
                      className="w-full rounded-lg bg-slate-800 border border-slate-700 text-sm px-3 py-2 text-slate-100 disabled:opacity-40 focus:outline-none focus:ring-1 focus:ring-purple-500"
                    >
                      {["low", "medium", "high", "xhigh", "max"].map(e => (
                        <option key={e} value={e}>{e[0].toUpperCase() + e.slice(1)}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 text-xs">
                  <span className={`w-1.5 h-1.5 rounded-full ${claudeKeyConfigured ? "bg-green-400" : "bg-red-400"}`} />
                  <span className={claudeKeyConfigured ? "text-green-400" : "text-red-400"}>
                    {claudeKeyConfigured ? "Claude API key configured" : "No Claude API key configured"}
                  </span>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs text-slate-400">Claude API key</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="password"
                      value={claudeApiKey}
                      onChange={e => { setClaudeApiKey(e.target.value); setClaudeKeySaved(false); }}
                      placeholder={claudeKeyConfigured ? "•••••••••••••••••••• (saved — enter to replace)" : "sk-ant-..."}
                      className="flex-1 rounded-lg bg-slate-800/60 border border-white/10 text-sm px-3 py-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-purple-500 font-mono"
                    />
                    <button
                      onClick={saveClaudeApiKey}
                      disabled={claudeKeySaving || !claudeApiKey.trim()}
                      className="rounded-lg bg-slate-700/80 hover:bg-slate-600/80 disabled:opacity-40 text-slate-200 font-medium text-sm px-4 py-2 transition-colors shrink-0"
                    >
                      {claudeKeySaving ? "Saving…" : claudeKeySaved ? "Saved!" : "Save"}
                    </button>
                  </div>
                  <p className="text-xs text-slate-500">
                    Stored on this Pi — Claude mixes run here directly, no separate AI DJ service PC required.
                  </p>
                  {claudeKeyError && <p className="text-xs text-red-400">{claudeKeyError}</p>}
                </div>
              </div>
            )}

            {aiDjProvider === "gemini" && (
              <div className="space-y-3 pt-1">
                <div className="space-y-1.5">
                  <label className="text-xs text-slate-400">Model</label>
                  <select
                    value={aiDjGeminiModel}
                    onChange={e => saveAiDj(aiDjEnabled, aiDjAutoPlaylist, "gemini", aiDjClaudeModel, aiDjClaudeEffort, e.target.value)}
                    disabled={aiDjSaving}
                    className="w-full rounded-lg bg-slate-800 border border-slate-700 text-sm px-3 py-2 text-slate-100 disabled:opacity-40 focus:outline-none focus:ring-1 focus:ring-purple-500"
                  >
                    <option value="gemini-2.5-flash">Flash 2.5</option>
                    <option value="gemini-2.5-flash-lite">Flash 2.5 Lite</option>
                  </select>
                  <p className="text-xs text-slate-500">Free-tier models only — gemini-2.5-pro isn&apos;t available without billing.</p>
                </div>

                <div className="flex items-center gap-1.5 text-xs">
                  <span className={`w-1.5 h-1.5 rounded-full ${geminiKeyConfigured ? "bg-green-400" : "bg-red-400"}`} />
                  <span className={geminiKeyConfigured ? "text-green-400" : "text-red-400"}>
                    {geminiKeyConfigured ? "Gemini API key configured" : "No Gemini API key configured"}
                  </span>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs text-slate-400">Gemini API key</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="password"
                      value={geminiApiKey}
                      onChange={e => { setGeminiApiKey(e.target.value); setGeminiKeySaved(false); }}
                      placeholder={geminiKeyConfigured ? "•••••••••••••••••••• (saved — enter to replace)" : "AIza..."}
                      className="flex-1 rounded-lg bg-slate-800/60 border border-white/10 text-sm px-3 py-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-purple-500 font-mono"
                    />
                    <button
                      onClick={saveGeminiApiKey}
                      disabled={geminiKeySaving || !geminiApiKey.trim()}
                      className="rounded-lg bg-slate-700/80 hover:bg-slate-600/80 disabled:opacity-40 text-slate-200 font-medium text-sm px-4 py-2 transition-colors shrink-0"
                    >
                      {geminiKeySaving ? "Saving…" : geminiKeySaved ? "Saved!" : "Save"}
                    </button>
                  </div>
                  <p className="text-xs text-slate-500">
                    Stored on this Pi — get a free key at{" "}
                    <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" className="text-purple-300 hover:text-purple-200 underline">
                      aistudio.google.com/apikey
                    </a>.
                  </p>
                  {geminiKeyError && <p className="text-xs text-red-400">{geminiKeyError}</p>}
                </div>
              </div>
            )}

            {(aiDjProvider === "claude" || aiDjProvider === "gemini") && (
              <div className="space-y-1.5 pt-3 mt-1 border-t border-white/5">
                <div className="flex items-center justify-between">
                  <label className="text-xs text-slate-400">Usage (accumulated on this Pi, by model)</label>
                  <button onClick={loadAiDjUsage} className="text-xs text-slate-500 hover:text-slate-300 underline transition-colors">
                    Refresh
                  </button>
                </div>
                {aiDjUsageError && <p className="text-xs text-red-400">{aiDjUsageError}</p>}
                {aiDjUsage && Object.keys(aiDjUsage).length === 0 && (
                  <p className="text-xs text-slate-600 italic">No calls made yet.</p>
                )}
                {aiDjUsage && Object.entries(aiDjUsage).map(([model, u]) => {
                  const maxTokens = Math.max(u.inputTokens, u.outputTokens, 1);
                  return (
                    <div key={model} className="space-y-1 rounded-lg bg-slate-900/50 border border-white/5 px-3 py-2">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-slate-300 font-medium">{model}</span>
                        <span className="text-slate-500">
                          {u.requests} request{u.requests === 1 ? "" : "s"} · ${u.estimatedCostUsd.toFixed(4)}
                          {u.errors > 0 && <span className="text-red-400"> · {u.errors} failed</span>}
                        </span>
                      </div>
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 text-[11px] text-slate-500">
                          <span className="w-14 shrink-0">Input</span>
                          <div className="flex-1 h-1.5 rounded-full bg-slate-800 overflow-hidden">
                            <div className="h-full bg-sky-500 rounded-full" style={{ width: `${Math.round((u.inputTokens / maxTokens) * 100)}%` }} />
                          </div>
                          <span className="w-16 text-right tabular-nums">{u.inputTokens.toLocaleString()}</span>
                        </div>
                        <div className="flex items-center gap-2 text-[11px] text-slate-500">
                          <span className="w-14 shrink-0">Output</span>
                          <div className="flex-1 h-1.5 rounded-full bg-slate-800 overflow-hidden">
                            <div className="h-full bg-purple-500 rounded-full" style={{ width: `${Math.round((u.outputTokens / maxTokens) * 100)}%` }} />
                          </div>
                          <span className="w-16 text-right tabular-nums">{u.outputTokens.toLocaleString()}</span>
                        </div>
                      </div>
                      {u.lastError && (
                        <p className="text-[11px] text-red-400/80 truncate" title={u.lastError}>{u.lastError}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="block text-sm font-medium text-slate-300">AI DJ service URL</label>
            {aiDjUrl.trim() && (
              <span className="flex items-center gap-1.5 text-xs">
                {aiDjHealth === "checking" && (
                  <>
                    <span className="w-1.5 h-1.5 rounded-full bg-slate-500 animate-pulse" />
                    <span className="text-slate-500">Checking…</span>
                  </>
                )}
                {aiDjHealth === "ok" && (
                  <>
                    <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                    <span className="text-green-400">Connected{aiDjHealthLlm ? " · LLM ready" : " · no LLM (distance-chain only)"}</span>
                  </>
                )}
                {aiDjHealth === "down" && (
                  <>
                    <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
                    <span className="text-red-400">{aiDjHealthMsg ?? "Unreachable"}</span>
                    <span className="text-slate-500">· mixes fall back to on-Pi processing</span>
                  </>
                )}
                <button
                  onClick={() => setAiDjCheckNonce(n => n + 1)}
                  disabled={aiDjHealth === "checking"}
                  className="ml-1 p-1 text-slate-500 hover:text-slate-300 disabled:opacity-40 transition-colors rounded"
                  title="Re-check connection now"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"
                    className={`w-3.5 h-3.5 ${aiDjHealth === "checking" ? "animate-spin" : ""}`}>
                    <path fillRule="evenodd" d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H3.989a.75.75 0 00-.75.75v4.242a.75.75 0 001.5 0v-2.43l.31.31a7 7 0 0011.712-3.138.75.75 0 00-1.449-.39zm1.23-3.723a.75.75 0 00.219-.53V2.929a.75.75 0 00-1.5 0V5.36l-.31-.31A7 7 0 003.239 8.188a.75.75 0 101.448.389A5.5 5.5 0 0113.89 6.11l.311.31h-2.432a.75.75 0 000 1.5h4.243a.75.75 0 00.53-.219z" clipRule="evenodd" />
                  </svg>
                </button>
              </span>
            )}
          </div>
          <input
            type="url"
            value={aiDjUrl}
            onChange={e => { setAiDjUrl(e.target.value); setAiDjSaved(false); }}
            placeholder="http://192.168.1.50:8765"
            className="w-full rounded-lg bg-slate-800/60 border border-white/10 text-sm px-3 py-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-purple-500"
          />
          <p className="text-xs text-slate-500">
            Where the AI DJ service is running (<code className="text-slate-400">python -m ai_dj.server</code> —
            on a PC with Ollama, or on this Pi with <code className="text-slate-400">--no-llm</code>).
          </p>
        </div>
        <div className="space-y-2">
          <label className="block text-sm font-medium text-slate-300">PC MAC address (Wake-on-LAN)</label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={aiDjWolMac}
              onChange={e => { setAiDjWolMac(e.target.value); setAiDjSaved(false); }}
              placeholder="50-EB-F6-23-7F-AF"
              className="flex-1 rounded-lg bg-slate-800/60 border border-white/10 text-sm px-3 py-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-purple-500 font-mono"
            />
            <button
              onClick={wakeAiDjPc}
              disabled={waking || !aiDjWolMac.trim()}
              className="rounded-lg border border-purple-500/30 bg-purple-500/15 hover:bg-purple-500/25 disabled:opacity-40 text-purple-300 font-medium text-sm px-4 py-2 transition-colors shrink-0"
              title="Send a Wake-on-LAN magic packet to the PC"
            >
              {waking ? "Waking…" : "⏻ Wake PC"}
            </button>
          </div>
          {wakeMsg && (
            <p className={`text-xs ${wakeMsg === "PC is up." ? "text-green-400" : wakeMsg.startsWith("Magic packet") ? "text-slate-400" : "text-red-400"}`}>
              {wakeMsg}
            </p>
          )}
          <p className="text-xs text-slate-500">
            Save after changing the MAC — the wake button uses the saved value. The Connected/Unreachable
            dot above doubles as the PC&apos;s up/down indicator (rechecked every minute).
          </p>
        </div>
        {aiDjError && <p className="text-sm text-red-400">{aiDjError}</p>}
        <button
          onClick={() => saveAiDj(aiDjEnabled)}
          disabled={aiDjSaving || !aiDjUrl.trim()}
          className="rounded-lg bg-slate-700/80 hover:bg-slate-600/80 disabled:opacity-40 text-slate-200 font-medium text-sm px-5 py-2 transition-colors"
        >
          {aiDjSaving ? "Saving…" : aiDjSaved ? "Saved!" : "Save"}
        </button>

        {/* LLM prompt log — every prompt sent during tracklist creation,
            same style as the GarminDB sync log. Written by ai_dj/llm.py on
            whichever host ran the call, so Claude/Gemini (on-Pi) mixes show
            here; Ollama calls log on the remote service PC instead. */}
        {aiDjEnabled && (
          <div className="space-y-1 pt-2 border-t border-white/5">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-slate-400">LLM prompt log <span className="font-normal text-slate-600">— click an entry for the full prompt</span></p>
              <button onClick={loadLlmLog} className="text-xs text-slate-500 hover:text-slate-300 underline transition-colors">
                Refresh
              </button>
            </div>
            {llmLog && llmLog.length === 0 && (
              <p className="text-xs text-slate-600 italic">No LLM calls logged yet (Claude/Gemini mixes log here; local-LLM calls log on the service PC).</p>
            )}
            {llmLog && llmLog.length > 0 && (
              <div className="rounded bg-slate-950/60 border border-white/5 px-2.5 py-2 space-y-1 max-h-64 overflow-y-auto">
                {llmLog.map((e, i) => {
                  const t = e.ts.includes("T") ? e.ts.split("T")[1] : e.ts;
                  const day = e.ts.includes("T") ? e.ts.split("T")[0].slice(5) : "";
                  return (
                    <details key={`${e.ts}-${i}`} className="font-mono text-[10px] leading-relaxed">
                      <summary className="cursor-pointer truncate list-none flex gap-2 items-baseline">
                        <span className="text-slate-600 shrink-0">{day} {t}</span>
                        <span className={`shrink-0 ${e.ok ? "text-green-500/70" : "text-red-400/80"}`}>{e.ok ? "✓" : "✗"}</span>
                        <span className="text-sky-500/70 shrink-0">{e.model}</span>
                        {e.source && (
                          <span className={`shrink-0 px-1 rounded text-[9px] ${e.source === "service" ? "bg-purple-500/10 text-purple-400/80" : "bg-slate-700/40 text-slate-500"}`}>
                            {e.source === "service" ? "PC" : "Pi"}
                          </span>
                        )}
                        {e.durationMs != null && <span className="text-slate-600 shrink-0">{(e.durationMs / 1000).toFixed(1)}s</span>}
                        <span className="text-slate-500 truncate">{e.prompt.split("\n")[0]}</span>
                      </summary>
                      <pre className="whitespace-pre-wrap text-slate-500 mt-1 mb-2 pl-3 border-l border-white/10 max-h-48 overflow-y-auto">
                        {`SYSTEM: ${e.system}\n\n${e.prompt}${e.error ? `\n\nERROR: ${e.error}` : ""}`}
                      </pre>
                    </details>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Runna */}
      <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 overflow-hidden">
        <div className="px-5 py-4 border-b border-white/10">
          <h2 className="font-semibold text-lg">Runna Integration</h2>
        </div>
        <div className="p-5 space-y-4">
        <p className="text-sm text-slate-400">
          Connect your Runna training calendar to see upcoming workouts and zone suggestions on the dashboard.
        </p>
        <div className="rounded-lg bg-slate-800/50 border border-white/5 p-4 space-y-2 text-xs text-slate-400">
          <p className="font-medium text-slate-300">How to find your iCal URL:</p>
          <ol className="list-decimal list-inside space-y-1">
            <li>Open the <span className="text-slate-200">Runna app</span> on your phone</li>
            <li>Tap <span className="text-slate-200">Profile</span> → <span className="text-slate-200">Settings</span></li>
            <li>Tap <span className="text-slate-200">Calendar Integration</span></li>
            <li>Copy the <span className="text-slate-200">iCal / Webcal URL</span></li>
          </ol>
          <p className="text-slate-500 pt-1">Keep this URL private — it gives read access to your training schedule.</p>
        </div>
        <div className="space-y-2">
          <label className="block text-sm font-medium text-slate-300">iCal URL</label>
          <input
            type="url"
            value={runnaUrl}
            onChange={e => { setRunnaUrl(e.target.value); setRunnaSaved(false); }}
            placeholder="https://app.runna.com/api/ical/..."
            className="w-full rounded-lg bg-slate-800/60 border border-white/10 text-sm px-3 py-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-green-500"
          />
        </div>
        {runnaError && <p className="text-sm text-red-400">{runnaError}</p>}
        <button
          onClick={saveRunnaUrl}
          disabled={runnaSaving || !runnaUrl.trim()}
          className="rounded-lg bg-slate-700/80 hover:bg-slate-600/80 disabled:opacity-40 text-slate-200 font-medium text-sm px-5 py-2 transition-colors"
        >
          {runnaSaving ? "Saving…" : runnaSaved ? "Saved!" : "Save URL"}
        </button>
        </div>
      </div>

    </div>
    <div className="space-y-6">

      {/* Strava */}
      <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5 space-y-4">
        <div>
          <h2 className="font-semibold text-lg">Strava</h2>
          <p className="text-sm text-slate-400 mt-1">
            Connect Strava for activity stats and heart-rate zones on the{" "}
            <Link href="/strava" className="text-orange-400 hover:text-orange-300 underline">Strava Stats</Link> page.
          </p>
        </div>
        <div className="rounded-lg bg-slate-800/50 border border-white/5 p-4 space-y-2 text-xs text-slate-400">
          <p className="font-medium text-slate-300">How to get a Client ID/Secret:</p>
          <ol className="list-decimal list-inside space-y-1">
            <li>Go to <a href="https://www.strava.com/settings/api" target="_blank" rel="noopener noreferrer" className="text-orange-400 hover:text-orange-300 underline">strava.com/settings/api</a> and create an app</li>
            <li>Set <span className="text-slate-200">Authorization Callback Domain</span> to this app&apos;s domain (no https://, no path)</li>
            <li>Copy the <span className="text-slate-200">Client ID</span> and <span className="text-slate-200">Client Secret</span> below</li>
          </ol>
        </div>
        <div className="space-y-2">
          <label className="block text-sm font-medium text-slate-300">Client ID</label>
          <input
            type="text"
            value={stravaClientId}
            onChange={e => { setStravaClientId(e.target.value); setStravaSaved(false); }}
            placeholder="123456"
            className="w-full rounded-lg bg-slate-800/60 border border-white/10 text-sm px-3 py-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-orange-500 font-mono"
          />
        </div>
        <div className="space-y-2">
          <label className="block text-sm font-medium text-slate-300">Client Secret</label>
          <input
            type="password"
            value={stravaClientSecret}
            onChange={e => { setStravaClientSecret(e.target.value); setStravaSaved(false); }}
            placeholder={stravaHasSecret ? "•••••••••••••••••••• (saved — enter to replace)" : "Client secret"}
            className="w-full rounded-lg bg-slate-800/60 border border-white/10 text-sm px-3 py-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-orange-500 font-mono"
          />
        </div>
        {stravaError && <p className="text-sm text-red-400">{stravaError}</p>}
        <div className="flex items-center gap-2">
          <button
            onClick={saveStrava}
            disabled={stravaSaving || !stravaClientId.trim() || (!stravaClientSecret.trim() && !stravaHasSecret)}
            className="rounded-lg bg-slate-700/80 hover:bg-slate-600/80 disabled:opacity-40 text-slate-200 font-medium text-sm px-5 py-2 transition-colors"
          >
            {stravaSaving ? "Saving…" : stravaSaved ? "Saved!" : "Save"}
          </button>
          {stravaHasSecret && (
            stravaConnected ? (
              <div className="flex items-center gap-3">
                <span className="text-xs text-green-400">
                  ✓ Connected{stravaAthleteName ? ` as ${stravaAthleteName}` : ""}
                </span>
                <a
                  href="/api/strava/connect"
                  className="text-xs text-orange-400 hover:text-orange-300 underline"
                >
                  Reconnect (needed if permissions changed)
                </a>
              </div>
            ) : (
              <a
                href="/api/strava/connect"
                className="rounded-lg border border-orange-500/40 bg-orange-500/15 hover:bg-orange-500/25 text-orange-300 font-medium text-sm px-4 py-2 transition-colors"
              >
                Connect Strava →
              </a>
            )
          )}
        </div>

        {stravaConnected && (
          <div className="space-y-2 pt-2 border-t border-white/5">
            <p className="text-sm font-medium text-slate-300">Auto-update activities from Runna</p>
            <p className="text-xs text-slate-500">
              When a new Strava activity is created, PaceSync appends the matching Runna workout&apos;s
              name and prepends its planned steps to the description — e.g. &quot;Morning Run&quot; becomes
              &quot;Morning Run — Steady into Tempo&quot;. Requires re-connecting Strava if you connected
              before this feature existed (needs the activity:write permission).
            </p>
            <div className="flex items-center gap-2">
              {stravaWebhookSubscribed ? (
                <>
                  <span className="text-xs text-green-400">✓ Subscribed — new activities will be updated automatically</span>
                  <button
                    onClick={unsubscribeStravaWebhook}
                    disabled={stravaWebhookLoading}
                    className="rounded-lg border border-red-500/30 bg-red-500/10 hover:bg-red-500/20 disabled:opacity-40 text-red-300 font-medium text-xs px-3 py-1.5 transition-colors"
                  >
                    {stravaWebhookLoading ? "Disabling…" : "Disable"}
                  </button>
                </>
              ) : (
                <button
                  onClick={subscribeStravaWebhook}
                  disabled={stravaWebhookLoading}
                  className="rounded-lg border border-orange-500/40 bg-orange-500/15 hover:bg-orange-500/25 disabled:opacity-40 text-orange-300 font-medium text-sm px-4 py-2 transition-colors"
                >
                  {stravaWebhookLoading ? "Subscribing…" : "Enable auto-update"}
                </button>
              )}
            </div>
            {stravaWebhookError && <p className="text-xs text-red-400">{stravaWebhookError}</p>}
          </div>
        )}
      </div>

      {/* Met Office weather */}
      <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5 space-y-4">
        <div>
          <h2 className="font-semibold text-base">Weather (Met Office)</h2>
          <p className="text-sm text-slate-400 mt-1">
            Shows run-time weather on the Runna schedule (midday weekdays, 10:00 weekends).
            Get a free API key at{" "}
            <a href="https://datahub.metoffice.gov.uk/" target="_blank" rel="noopener noreferrer" className="text-green-400 hover:text-green-300 underline">
              datahub.metoffice.gov.uk
            </a>{" "}
            — subscribe to the Site-Specific Forecast (free plan).
          </p>
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-sm text-slate-300">API Key</label>
            <input
              type="password"
              value={metofficeKey}
              onChange={e => { setMetofficeKey(e.target.value); setMetofficeSaved(false); }}
              placeholder={metofficeHasKey ? "•••••••••••••••••••• (saved — enter to replace)" : "API key"}
              className="w-full rounded-lg bg-slate-800/80 border border-white/10 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-green-500/50"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm text-slate-300">Postcode</label>
            <input
              type="text"
              value={metofficePostcode}
              onChange={e => { setMetofficePostcode(e.target.value); setMetofficeSaved(false); }}
              placeholder="NG12 4BD"
              className="w-full rounded-lg bg-slate-800/80 border border-white/10 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-green-500/50"
            />
          </div>
        </div>
        {metofficeError && <p className="text-sm text-red-400">{metofficeError}</p>}
        <div className="flex items-center gap-3">
          <button
            onClick={saveMetoffice}
            disabled={metofficeSaving || (!metofficeKey.trim() && !metofficeHasKey)}
            className="rounded-lg bg-slate-700/80 hover:bg-slate-600/80 disabled:opacity-40 text-slate-200 font-medium text-sm px-5 py-2 transition-colors"
          >
            {metofficeSaving ? "Saving…" : metofficeSaved ? "Saved!" : "Save"}
          </button>
          {metofficeHasKey && <span className="text-xs text-green-400">✓ Configured</span>}
        </div>
      </div>

      {/* Garmin DB */}
      <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5 space-y-4">
        <div>
          <h2 className="font-semibold text-base">Garmin DB</h2>
          <p className="text-sm text-slate-400 mt-1">
            Path to the GarminDB SQLite files on this device. Enables the{" "}
            <a href="/garmin" className="text-green-400 hover:text-green-300 underline">Garmin Stats</a>{" "}
            page.
          </p>
        </div>
        {garminConfigured && (
          <div className="flex items-center gap-2 text-sm text-green-400">
            <span>●</span>
            <span>Connected — DB path saved</span>
          </div>
        )}

        {/* GarminDB sync status */}
        {garminConfigured && syncStatus && (
          <div className="rounded-lg bg-slate-800/50 border border-white/5 p-3 space-y-2.5">
            <div className="flex items-center gap-2">
              {syncStatus.running ? (
                <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse shrink-0" />
              ) : (
                <span className="w-2 h-2 rounded-full bg-slate-500 shrink-0" />
              )}
              <span className="text-xs font-medium text-slate-300">
                {syncStatus.running ? (() => {
                  const s = (syncStatus.progress?.section ?? "").toLowerCase();
                  if (s.includes("download") || s.includes("getting"))
                    return "Syncing — Downloading from Garmin";
                  if (s.includes("analyz") || s.includes("import"))
                    return "Syncing — Updating local files";
                  return "Syncing";
                })() : "Sync idle"}
              </span>
              {!syncStatus.running && syncStatus.lastRun && (
                <span className="text-xs text-slate-600">
                  Last run: {new Date(syncStatus.lastRun).toLocaleString([], {
                    month: "short", day: "numeric",
                    hour: "2-digit", minute: "2-digit",
                  })}
                </span>
              )}
              <button
                onClick={async () => {
                  if (syncStatus.running) return;
                  await fetch("/api/settings/garmin/sync-status", { method: "POST" });
                  fetchSyncStatus();
                }}
                disabled={syncStatus.running}
                className="ml-auto text-xs px-2.5 py-1 rounded bg-green-600/20 border border-green-600/30 text-green-400 hover:bg-green-600/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
              >
                {syncStatus.running ? "Running…" : "Sync now"}
              </button>
            </div>

            {syncStatus.running && syncStatus.progress && (() => {
              const p = syncStatus.progress;

              function fmtEta(eta: string): string {
                if (!eta || eta.includes("?")) return "";
                const parts = eta.split(":").map(Number);
                if (parts.length === 3 && parts[0] > 0) return `~${parts[0]}h ${parts[1]}m remaining`;
                if (parts.length >= 2) return `~${parts[parts.length - 2]}m remaining`;
                return "";
              }

              return (
                <>
                  <div className="h-1.5 w-full rounded-full bg-slate-700">
                    <div
                      className="h-1.5 rounded-full bg-green-500 transition-all duration-700"
                      style={{ width: `${p.percent}%` }}
                    />
                  </div>
                  <div className="flex items-baseline justify-between">
                    <span className="text-xs text-slate-300 font-mono tabular-nums">
                      {p.current.toLocaleString()} / {p.total.toLocaleString()}
                    </span>
                    <span className="text-xs font-semibold text-slate-400">{p.percent}%</span>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                    <span>Elapsed: <span className="text-slate-400">{p.elapsed}</span></span>
                    <span>Speed: <span className="text-slate-400">{p.speed}</span></span>
                    {fmtEta(p.eta) && (
                      <span className="text-slate-400">{fmtEta(p.eta)}</span>
                    )}
                  </div>
                </>
              );
            })()}

            {/* Log tail */}
            {syncStatus.logTail && syncStatus.logTail.length > 0 && (
              <div className="rounded bg-slate-950/60 border border-white/5 px-2.5 py-2 mt-1 space-y-px">
                {syncStatus.logTail.map((line, i) => {
                  const tsMatch = line.match(/^\[(\d{2}:\d{2}:\d{2})\]\s*(.*)/);
                  const ts = tsMatch ? tsMatch[1] : null;
                  const text = tsMatch ? tsMatch[2] : line;
                  const isMarker = text.startsWith("===");
                  const isSection = /^_{3}/.test(text);
                  return (
                    <div key={i} className="flex gap-2 items-baseline font-mono text-[10px] leading-relaxed">
                      {ts && (
                        <span className="text-slate-600 shrink-0">{ts}</span>
                      )}
                      <span className={`truncate ${
                        isMarker ? "text-green-500/70" :
                        isSection ? "text-slate-300 font-semibold" :
                        "text-slate-500"
                      }`}>
                        {text}
                      </span>
                    </div>
                  );
                })}
                {!syncStatus.running && syncStatus.lastRun && (
                  <div className="flex gap-2 items-baseline font-mono text-[10px] leading-relaxed mt-1 pt-1 border-t border-white/5">
                    <span className="text-green-500/60">✓</span>
                    <span className="text-green-500/60">
                      Completed {new Date(syncStatus.lastRun).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div className="space-y-2">
          <label className="block text-sm font-medium text-slate-300">DB folder path</label>
          <input
            type="text"
            value={garminDbPath}
            onChange={e => { setGarminDbPath(e.target.value); setGarminSaved(false); }}
            placeholder="/home/scott/HealthData/DBs"
            className="w-full rounded-lg bg-slate-800/60 border border-white/10 text-sm px-3 py-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-green-500 font-mono"
          />
        </div>
        {garminError && <p className="text-sm text-red-400">{garminError}</p>}
        <div className="flex items-center gap-3">
          <button
            onClick={saveGarminConfig}
            disabled={garminSaving}
            className="rounded-lg bg-slate-700/80 hover:bg-slate-600/80 disabled:opacity-40 text-slate-200 font-medium text-sm px-5 py-2 transition-colors"
          >
            {garminSaving ? "Saving…" : garminSaved ? "Saved!" : "Save path"}
          </button>
          {garminConfigured && (
            <button
              onClick={removeGarminConfig}
              className="text-xs text-slate-600 hover:text-red-400 transition-colors"
            >
              Remove
            </button>
          )}
        </div>
      </div>

    </div>
    </div>

    {/* ── Tab 4: Notifications & 2FA ── */}
    <div className={activeTab === "notifications" ? "grid grid-cols-1 lg:grid-cols-2 gap-6 items-start" : "hidden"}>
    <div className="space-y-6">

      {/* ntfy Notifications */}
      <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5 space-y-4">
        <div>
          <h3 className="font-semibold text-slate-200">Push Notifications</h3>
          <p className="text-sm text-slate-400 mt-1">
            Get notified on your phone when the weekly playlist update runs, using{" "}
            <a href="https://ntfy.sh" target="_blank" rel="noopener noreferrer" className="text-green-400 hover:text-green-300 underline">ntfy.sh</a>.
          </p>
        </div>
        <div className="rounded-lg bg-slate-800/50 border border-white/5 p-4 space-y-2 text-xs text-slate-400">
          <p className="font-medium text-slate-300">How to set up ntfy.sh:</p>
          <ol className="list-decimal list-inside space-y-1">
            <li>Install the <span className="text-slate-200">ntfy app</span> on your phone (iOS or Android)</li>
            <li>Subscribe to a topic — choose any unique name, e.g. <span className="text-slate-200 font-mono">my_running_playlist</span></li>
            <li>Enter the same topic name below and click Save</li>
          </ol>
          <p className="text-slate-500 pt-1">
            Topic names are public on ntfy.sh — use something hard to guess. Leave blank to disable notifications.
          </p>
        </div>
        <div className="space-y-2">
          <label className="block text-sm font-medium text-slate-300">ntfy Topic</label>
          <input
            type="text"
            value={ntfyTopic}
            onChange={e => { setNtfyTopic(e.target.value); setNtfySaved(false); }}
            placeholder="e.g. my_running_playlist_abc123"
            className="w-full rounded-lg bg-slate-800/60 border border-white/10 text-sm px-3 py-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-green-500 font-mono"
          />
        </div>
        {ntfyError && <p className="text-sm text-red-400">{ntfyError}</p>}
        {ntfyTestMsg && <p className="text-sm text-green-400">{ntfyTestMsg}</p>}
        <div className="flex items-center gap-2">
          <button
            onClick={saveNtfyTopic}
            disabled={ntfySaving}
            className="rounded-lg bg-slate-700/80 hover:bg-slate-600/80 disabled:opacity-40 text-slate-200 font-medium text-sm px-5 py-2 transition-colors"
          >
            {ntfySaving ? "Saving…" : ntfySaved ? "Saved!" : "Save topic"}
          </button>
          <button
            onClick={testNtfyTopic}
            disabled={ntfyTesting || !ntfyTopic.trim()}
            className="rounded-lg border border-white/10 hover:border-green-500/40 hover:text-green-300 disabled:opacity-40 text-slate-300 font-medium text-sm px-5 py-2 transition-colors"
          >
            {ntfyTesting ? "Sending…" : "Send test"}
          </button>
        </div>
      </div>

      {/* Scheduled jobs */}
      <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5 space-y-4">
        <div>
          <h2 className="font-semibold text-base">⏰ Scheduled Jobs</h2>
          <p className="text-sm text-slate-400 mt-1">
            The automatic jobs on the Pi&apos;s crontab — set when each runs, or switch them off.
          </p>
        </div>
        {!cronAvailable ? (
          <p className="text-sm text-slate-500">
            The schedule can only be managed on the Pi itself (crontab isn&apos;t available here).
          </p>
        ) : (
          <>
            {([
              { key: "garmin", label: "Garmin sync", desc: "Downloads new activities into GarminDB" },
              { key: "weekly", label: "BBC playlist refresh", desc: "Re-fetches BBC programme tracks and removes duplicates" },
              { key: "aidj", label: "AI DJ pre-build", desc: "Builds tomorrow's mix and saves it to “Today's Run”" },
            ] as const).map(meta => {
              const job = cronJobs.find(j => j.key === meta.key);
              if (!job) return null;
              return (
                <div key={meta.key} className="rounded-lg bg-slate-800/40 border border-white/5 px-3 py-2.5 space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-slate-300">{meta.label}</p>
                      <p className="text-xs text-slate-500 mt-0.5">{meta.desc}</p>
                    </div>
                    <button
                      role="switch"
                      aria-checked={job.enabled}
                      onClick={() => { if (job.installed) patchCronJob(job.key, { enabled: !job.enabled }); }}
                      disabled={!job.installed || cronSaving}
                      className={`relative shrink-0 w-11 h-6 rounded-full transition-colors disabled:opacity-40 ${
                        job.enabled ? "bg-sky-500" : "bg-slate-700"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                          job.enabled ? "translate-x-5" : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>
                  {job.installed ? (
                    <div className="flex items-center gap-2">
                      <select
                        value={job.day === null ? "" : String(job.day)}
                        onChange={e => patchCronJob(job.key, { day: e.target.value === "" ? null : parseInt(e.target.value, 10) })}
                        disabled={!job.enabled || cronSaving}
                        className="rounded-lg bg-slate-800 border border-slate-700 text-xs px-2 py-1.5 text-slate-100 disabled:opacity-40 focus:outline-none focus:ring-1 focus:ring-sky-500"
                      >
                        <option value="">Every day</option>
                        {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((d, i) => (
                          <option key={d} value={i}>{d}</option>
                        ))}
                      </select>
                      <span className="text-xs text-slate-500">at</span>
                      <input
                        type="time"
                        value={job.time}
                        onChange={e => patchCronJob(job.key, { time: e.target.value })}
                        disabled={!job.enabled || cronSaving}
                        className="rounded-lg bg-slate-800 border border-slate-700 text-xs px-2 py-1.5 text-slate-100 disabled:opacity-40 focus:outline-none focus:ring-1 focus:ring-sky-500"
                      />
                    </div>
                  ) : (
                    <p className="text-xs text-slate-600">Not installed on this machine&apos;s crontab.</p>
                  )}
                </div>
              );
            })}
            {cronJobsError && <p className="text-sm text-red-400">{cronJobsError}</p>}
            <button
              onClick={saveCronJobs}
              disabled={cronSaving || cronJobs.every(j => !j.installed)}
              className="rounded-lg bg-slate-700/80 hover:bg-slate-600/80 disabled:opacity-40 text-slate-200 font-medium text-sm px-5 py-2 transition-colors"
            >
              {cronSaving ? "Saving…" : cronSaved ? "Saved!" : "Save schedule"}
            </button>

            {/* Activity log — last 48h, newest first (same style as the GarminDB sync log) */}
            {cronLog.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-slate-400">Latest activity</p>
                <div className="rounded bg-slate-950/60 border border-white/5 px-2.5 py-2 space-y-px max-h-44 overflow-y-auto">
                  {[...cronLog].reverse().map((e, i) => {
                    const d = new Date(e.ts);
                    const ts = isNaN(d.getTime())
                      ? ""
                      : `${d.toLocaleDateString([], { weekday: "short" })} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
                    const ok = e.message.startsWith("✓");
                    const fail = e.message.startsWith("✗");
                    return (
                      <div key={i} className="flex gap-2 items-baseline font-mono text-[10px] leading-relaxed">
                        {ts && <span className="text-slate-600 shrink-0">{ts}</span>}
                        <span className="text-sky-500/70 shrink-0">{e.job}</span>
                        <span className={`truncate ${ok ? "text-green-500/70" : fail ? "text-red-400/80" : "text-slate-500"}`} title={e.message}>
                          {e.message}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>

    </div>
    <div className="space-y-6">

      {/* Two-factor authentication */}
      <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5 space-y-4">
        <div>
          <h3 className="font-semibold text-slate-200">🔐 Two-Factor Authentication</h3>
          <p className="text-sm text-slate-400 mt-1">
            Adds a 6-digit authenticator code to the sign-in page. Works with LastPass Authenticator,
            Google Authenticator, or any TOTP app.
          </p>
        </div>

        {totpEnabled === null && (
          <div className="h-10 rounded-lg bg-slate-800/50 animate-pulse" />
        )}

        {totpEnabled === true && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-green-400">
              <span>●</span>
              <span>2FA is enabled — codes required at sign-in</span>
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-300">Enter a current code to disable</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={totpCode}
                  onChange={e => setTotpCode(e.target.value.replace(/\D/g, ""))}
                  placeholder="123456"
                  className="w-28 rounded-lg bg-slate-800/60 border border-white/10 text-sm px-3 py-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-red-500 font-mono tracking-widest"
                />
                <button
                  onClick={disableTotp}
                  disabled={totpBusy || totpCode.length !== 6}
                  className="rounded-lg bg-slate-700/80 hover:bg-red-500/30 disabled:opacity-40 text-slate-200 font-medium text-sm px-4 py-2 transition-colors"
                >
                  {totpBusy ? "…" : "Disable 2FA"}
                </button>
              </div>
            </div>
          </div>
        )}

        {totpEnabled === false && (
          <div className="space-y-3">
            <ol className="text-xs text-slate-500 space-y-1 list-decimal list-inside">
              <li>Open <span className="text-slate-300">LastPass Authenticator</span> and tap <span className="text-slate-300">+</span></li>
              <li>Scan the QR code below</li>
              <li>Enter the 6-digit code it shows to confirm</li>
            </ol>
            {totpQr ? (
              <div className="flex items-start gap-4 flex-wrap">
                <img src={totpQr} alt="2FA QR code" className="rounded-lg border border-white/10 bg-white p-1 w-[180px] h-[180px]" />
                <div className="space-y-2 min-w-0">
                  {totpSecret && (
                    <p className="text-xs text-slate-500 break-all">
                      Can&apos;t scan? Enter manually:{" "}
                      <code className="text-slate-300 font-mono">{totpSecret}</code>
                    </p>
                  )}
                  <div className="space-y-2 pt-1">
                    <label className="block text-sm font-medium text-slate-300">Confirmation code</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        inputMode="numeric"
                        maxLength={6}
                        value={totpCode}
                        onChange={e => setTotpCode(e.target.value.replace(/\D/g, ""))}
                        placeholder="123456"
                        className="w-28 rounded-lg bg-slate-800/60 border border-white/10 text-sm px-3 py-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-green-500 font-mono tracking-widest"
                      />
                      <button
                        onClick={confirmTotp}
                        disabled={totpBusy || totpCode.length !== 6}
                        className="rounded-lg bg-green-500 hover:bg-green-400 disabled:opacity-40 text-black font-semibold text-sm px-4 py-2 transition-colors"
                      >
                        {totpBusy ? "Verifying…" : "Enable 2FA"}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="h-[180px] w-[180px] rounded-lg bg-slate-800/50 animate-pulse" />
            )}
          </div>
        )}

        {totpError && <p className="text-sm text-red-400">{totpError}</p>}
        {totpMsg && <p className="text-sm text-green-400">{totpMsg}</p>}
      </div>

    </div>
    </div>

    {/* ── Tab 5: Deleted Tracks ── */}
    <div className={activeTab === "deleted-tracks" ? "grid grid-cols-1 gap-6 items-start" : "hidden"}>
    <div className="space-y-6">

      <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5 space-y-4">
        <div>
          <h3 className="font-semibold text-slate-200">Deleted Tracks</h3>
          <p className="text-sm text-slate-400 mt-1">
            Tracks removed from the library are logged here so they don&apos;t silently reappear via BBC episodes, CSV imports, or the weekly cron.
            Removing a track from this list lets it be imported again without a review prompt. Click a track to play it in Spotify.
          </p>
        </div>

        {deletedTracksError && <p className="text-sm text-red-400">{deletedTracksError}</p>}

        {deletedTracksLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map(n => <div key={n} className="h-10 rounded-lg bg-slate-800/50 animate-pulse" />)}
          </div>
        ) : !deletedTracksList || deletedTracksList.length === 0 ? (
          <p className="text-sm text-slate-500">No deleted tracks logged.</p>
        ) : (
          <div className="divide-y divide-white/5 rounded-lg border border-white/10 bg-slate-950/40 max-h-[28rem] overflow-y-auto">
            {deletedTracksList.map(t => (
              <div key={t.uri} className="flex items-center gap-3 px-3 py-2 group">
                <button
                  onClick={() => openInSpotify(t.uri)}
                  className="min-w-0 flex-1 text-left"
                  title="Play in Spotify"
                >
                  <p className="text-sm text-slate-200 truncate group-hover:text-green-400 transition-colors">
                    {t.name}{t.artist ? <span className="text-slate-500"> — {t.artist}</span> : null}
                  </p>
                  <p className="text-xs text-slate-600">Deleted {t.deletedAt.slice(0, 10)}</p>
                </button>
                <button
                  onClick={() => forgetDeletedTrack(t.uri)}
                  disabled={forgettingUris.has(t.uri)}
                  className="shrink-0 text-xs px-3 py-1.5 rounded-lg border border-white/10 bg-slate-800/60 hover:bg-slate-700/60 disabled:opacity-40 disabled:cursor-not-allowed text-slate-300 font-medium transition-colors"
                >
                  {forgettingUris.has(t.uri) ? "Removing…" : "Remove"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

    </div>
    </div>

    {deleteTarget && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
        <div className="rounded-xl bg-slate-900 border border-white/10 p-5 max-w-sm w-full space-y-4">
          <div>
            <h3 className="font-semibold text-slate-100">Delete "{deleteTarget.name}"?</h3>
            <p className="text-sm text-slate-400 mt-1">
              This removes the playlist from PaceSync and deletes its local library file
              ({deleteTarget.csvFile}) from the Pi.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={deleteUnfollow}
              onChange={e => setDeleteUnfollow(e.target.checked)}
              className="rounded border-white/20 bg-slate-800"
            />
            Also unfollow on Spotify (removes it from your Spotify library)
          </label>
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={() => setDeleteTarget(null)}
              disabled={deleting}
              className="rounded-lg bg-slate-700/80 hover:bg-slate-600/80 disabled:opacity-40 text-slate-200 text-sm font-medium px-4 py-2 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={confirmDeletePlaylist}
              disabled={deleting}
              className="rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white text-sm font-semibold px-4 py-2 transition-colors"
            >
              {deleting ? "Deleting…" : "Delete"}
            </button>
          </div>
        </div>
      </div>
    )}

    </div>
  );
}
