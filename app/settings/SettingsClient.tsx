"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import type { RunningZone } from "@/types";
import { BbcBrowserCard } from "@/components/BbcBrowserCard";
import { invalidateRunningPlaylistCache } from "@/components/useRunningPlaylist";

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
  const [zones, setZones] = useState<ZoneRow[]>(calcZones(166, 39));
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
  const [aiDjHealthMsg, setAiDjHealthMsg] = useState<string | null>(null);
  const [aiDjWolMac, setAiDjWolMac] = useState("");
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

  // ── AI DJ library import state ─────────────────────────────────────────────
  const [libPlaylistName, setLibPlaylistName] = useState("");
  const aiDjLibraryFileRef = useRef<HTMLInputElement>(null);
  const [libImportMode, setLibImportMode] = useState<"overwrite" | "append">("append");
  const [libLoading, setLibLoading] = useState(false);
  const [libProgress, setLibProgress] = useState(0);
  const [libProgressTotal, setLibProgressTotal] = useState(0);
  const [libTracks, setLibTracks] = useState<{ uri: string; name: string; artistName: string; originalTitle: string; originalArtist: string }[]>([]);
  const [libError, setLibError] = useState<string | null>(null);
  const [libSaving, setLibSaving] = useState(false);
  const [libSavedMsg, setLibSavedMsg] = useState<string | null>(null);
  const [libFileName, setLibFileName] = useState<string | null>(null);

  const [cronRunning, setCronRunning] = useState(false);
  const [cronResults, setCronResults] = useState<{ name: string; matched: number; found: number; error?: string }[] | null>(null);
  const [cronSummary, setCronSummary] = useState<{ totalMatched: number; dedupRemoved: number; dedupRemaining: number } | null>(null);
  const [cronError, setCronError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/settings/hr-zones")
      .then(r => r.json())
      .then((data: { zones: RunningZone[]; maxHR?: number; restingHR?: number }) => {
        if (data.zones) setZones(data.zones.map(z => ({ min: z.hrMin, max: z.hrMax })));
        if (data.maxHR)     setMaxHR(data.maxHR);
        if (data.restingHR) setRestingHR(data.restingHR);
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
      .then((d: { url?: string; enabled?: boolean; autoPlaylist?: boolean; wolMac?: string }) => {
        if (d.url) setAiDjUrl(d.url);
        setAiDjEnabled(d.enabled ?? false);
        setAiDjAutoPlaylist(d.autoPlaylist ?? true);
        setAiDjWolMac(d.wolMac ?? "");
      })
      .catch(() => {});
  }, []);

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
  const [knownPlaylists, setKnownPlaylists] = useState<{ name: string; id: string; csvFile: string }[]>([]);
  const [playlistsLoaded, setPlaylistsLoaded] = useState(false);
  const [activePlaylistId, setActivePlaylistId] = useState<string | null>(null);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ name: string; id: string; csvFile: string } | null>(null);
  const [deleteUnfollow, setDeleteUnfollow] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [playlistListError, setPlaylistListError] = useState<string | null>(null);

  function loadPlaylistList() {
    fetch("/api/settings/playlists")
      .then(r => r.json())
      .then((d: { playlists?: { name: string; id: string; csvFile: string }[]; activeId?: string }) => {
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
      const res = await fetch("/api/settings/playlists", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const d = await res.json() as { error?: string; name?: string };
      if (!res.ok) throw new Error(d.error ?? "Failed to switch");
      invalidateRunningPlaylistCache();
      setActivePlaylistId(id);
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
        const d = await res.json() as { ok?: boolean; llm?: boolean; error?: string };
        if (cancelled) return;
        setAiDjHealth(d.ok ? "ok" : "down");
        setAiDjHealthLlm(!!d.llm);
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
    if (n > restingHR) { setZones(calcZones(n, restingHR)); setSaved(false); }
  };

  const handleRestingHR = (val: string) => {
    const n = parseInt(val) || 0;
    setRestingHR(n);
    if (maxHR > n) { setZones(calcZones(maxHR, n)); setSaved(false); }
  };

  const updateZone = (i: number, field: "min" | "max", val: string) => {
    const n = parseInt(val) || 0;
    setZones(prev => prev.map((z, idx) => idx === i ? { ...z, [field]: n } : z));
    setSaved(false);
  };

  const resetToCalc = () => { setZones(calcZones(maxHR, restingHR)); setSaved(false); };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/hr-zones", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxHR, restingHR, zones }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to save");
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

  async function saveAiDj(enabled: boolean, autoPlaylist: boolean = aiDjAutoPlaylist) {
    setAiDjSaving(true);
    setAiDjSaved(false);
    setAiDjError(null);
    try {
      const res = await fetch("/api/settings/ai-dj", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: aiDjUrl.trim(), enabled, autoPlaylist, wolMac: aiDjWolMac.trim() }),
      });
      if (!res.ok) throw new Error();
      setAiDjEnabled(enabled);
      setAiDjAutoPlaylist(autoPlaylist);
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

  async function saveCsvToPlaylist() {
    const name = csvPlaylistName.trim();
    if (!name) { setCsvError("Enter a playlist name first — this is both its name on Spotify and its filename on the Pi."); return; }
    if (!csvStagedText) return;
    setCsvSaving(true);
    setCsvError(null);
    try {
      await resolvePlaylistByName(name);
      const res = await fetch(`/api/save-default-playlist?mode=${csvImportMode}`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: csvStagedText,
      });
      const d = await res.json() as { appended?: number; skipped?: number };
      if (csvImportMode === "append" && d.appended !== undefined) setCsvTrackCount(d.appended);
      setCsvSaved(true);
      setCsvStagedText(null);
    } catch {
      setCsvError("Failed to save — try again.");
    } finally {
      setCsvSaving(false);
    }
  }

  function parseCsvRowLocal(line: string): string[] {
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

  async function addTracksBrowser(playlistId: string, uris: string[], token: string): Promise<void> {
    for (let i = 0; i < uris.length; i += 100) {
      const res = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/items`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ uris: uris.slice(i, i + 100) }),
      });
      if (!res.ok) throw new Error(`Spotify ${res.status}: ${await res.text()}`);
    }
  }

  async function replacePlaylistTracksBrowser(playlistId: string, uris: string[], token: string): Promise<void> {
    const putRes = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/items`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ uris: uris.slice(0, 100) }),
    });
    if (!putRes.ok) throw new Error(`Spotify ${putRes.status}: ${await putRes.text()}`);
    if (uris.length > 100) await addTracksBrowser(playlistId, uris.slice(100), token);
  }

  // A single request over ~1500+ tracks can run for several minutes (each
  // miss now tries up to 4 search variants) — long enough to risk a timeout
  // somewhere between the browser and the server regardless of what's
  // fronting it. Chunking keeps every individual request short.
  const LIBRARY_LOOKUP_CHUNK_SIZE = 150;

  type LibTrack = { uri: string; name: string; artistName: string; originalTitle: string; originalArtist: string };

  // Streams the SSE lookup for a batch of {title, artist} pairs, chunking
  // large batches into several requests. Shared by the initial upload and
  // "Retry all misses" — bypassCache skips the disk cache so a retry with
  // the looser search variants isn't short-circuited by a previously-cached
  // miss. Returns whatever matched even if Spotify rate-limits partway
  // through (via `warning`) rather than throwing and losing that progress.
  async function runLibraryLookup(
    tracks: { title: string; artist: string }[],
    bypassCache: boolean
  ): Promise<{ tracks: LibTrack[]; warning: string | null }> {
    const token = session?.accessToken;
    if (!token) throw new Error("Not signed in");

    setLibLoading(true);
    setLibProgress(0);
    setLibProgressTotal(tracks.length);

    try {
      const combined: LibTrack[] = [];

      for (let chunkStart = 0; chunkStart < tracks.length; chunkStart += LIBRARY_LOOKUP_CHUNK_SIZE) {
        const chunk = tracks.slice(chunkStart, chunkStart + LIBRARY_LOOKUP_CHUNK_SIZE);

        const res = await fetch("/api/ai-dj-library/lookup", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ tracks: chunk, bypassCache }),
        });
        if (!res.body) throw new Error("No response body");

        const reader2 = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let chunkRetryAfter: number | null = null;

        while (true) {
          const { done, value } = await reader2.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";

          for (const part of parts) {
            if (!part.startsWith("data: ")) continue;
            const msg = JSON.parse(part.slice(6)) as Record<string, unknown>;
            if (msg.type === "progress") {
              setLibProgress(chunkStart + (msg.current as number));
            } else if (msg.type === "done") {
              combined.push(...((msg.tracks as LibTrack[]) ?? []));
              chunkRetryAfter = (msg.retryAfter as number | null) ?? null;
            } else if (msg.type === "error") {
              throw new Error(msg.error as string);
            }
          }
        }

        // Spotify rate-limited us partway through this chunk — the remaining
        // tracks in it came back as misses with no real search attempted.
        // Stop here rather than silently continuing to burn through misses;
        // whatever matched so far is still returned to the caller.
        if (chunkRetryAfter !== null) {
          const clearsAt = new Date(Date.now() + chunkRetryAfter * 1000);
          const today = new Date();
          const isTomorrow = clearsAt.toDateString() !== today.toDateString();
          const timeStr = clearsAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }).toLowerCase().replace(" ", "");
          const clearsAtStr = isTomorrow ? `${timeStr} tomorrow` : timeStr;
          return {
            tracks: combined,
            warning: `Spotify rate-limited the search — stopped after ${chunkStart + chunk.length}/${tracks.length} tracks checked. Clears around ${clearsAtStr}.`,
          };
        }

        // Brief pause between chunks so a burst of many small requests
        // doesn't itself trip Spotify's rate limit.
        if (chunkStart + LIBRARY_LOOKUP_CHUNK_SIZE < tracks.length) await new Promise(r => setTimeout(r, 300));
      }
      return { tracks: combined, warning: null };
    } finally {
      setLibLoading(false);
      setLibProgress(0);
      setLibProgressTotal(0);
    }
  }

  function handleAiDjLibraryUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setLibError(null);
    setLibSavedMsg(null);
    setLibTracks([]);
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const text = ev.target?.result as string;
      const stripped = text.charCodeAt(0) === 65279 ? text.slice(1) : text;
      const lines = stripped.replace(/\r/g, "").split("\n").filter(Boolean);
      if (lines.length < 2) { setLibError("File appears to be empty."); return; }

      const headers = parseCsvRowLocal(lines[0]).map(h => h.toLowerCase());
      const idxName = headers.findIndex(h => h === "track name");
      const idxArtist = headers.findIndex(h => h === "artist name(s)" || h === "artist");
      if (idxName === -1 || idxArtist === -1) {
        setLibError(`Could not find Track Name / Artist Name(s) columns. Found: ${headers.join(", ")}`);
        return;
      }

      const parsed = lines.slice(1).map(l => parseCsvRowLocal(l)).filter(row => row[idxName] && row[idxArtist]);
      if (parsed.length === 0) { setLibError("No usable rows found in this CSV."); return; }

      setLibFileName(file.name);
      try {
        const { tracks, warning } = await runLibraryLookup(
          parsed.map(row => ({ title: row[idxName], artist: row[idxArtist] })),
          false
        );
        setLibTracks(tracks);
        if (warning) setLibError(warning);
      } catch (err) {
        setLibError(err instanceof Error ? err.message : "Failed to look up tracks");
      }
    };
    reader.readAsText(file);
  }

  // Re-searches every currently-unmatched track with the disk cache bypassed,
  // so the server's looser fallback query variants get a real shot instead of
  // being short-circuited by a previously-cached miss for the exact query.
  async function retryLibraryMisses() {
    const misses = libTracks.filter(t => !t.uri);
    if (!misses.length) return;
    setLibError(null);
    try {
      const { tracks: result, warning } = await runLibraryLookup(
        misses.map(t => ({ title: t.originalTitle, artist: t.originalArtist })),
        true
      );
      const byKey = new Map(result.map(r => [`${r.originalTitle}|||${r.originalArtist}`, r]));
      setLibTracks(prev => prev.map(t => {
        if (t.uri) return t;
        const updated = byKey.get(`${t.originalTitle}|||${t.originalArtist}`);
        return updated ?? t;
      }));
      if (warning) setLibError(warning);
    } catch (err) {
      setLibError(err instanceof Error ? err.message : "Failed to retry misses");
    }
  }

  function csvEscapeLocal(v: string): string {
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }

  async function saveAiDjLibraryToPlaylist() {
    const token = session?.accessToken;
    if (!token) { setLibError("Not signed in"); return; }
    const name = libPlaylistName.trim();
    if (!name) { setLibError("Enter a playlist name first."); return; }
    const matched = libTracks.filter(t => t.uri);
    if (!matched.length) { setLibError("No matched tracks to save."); return; }
    const uris = matched.map(t => t.uri);

    setLibSaving(true);
    setLibError(null);
    setLibSavedMsg(null);
    try {
      const playlist = await resolvePlaylistByName(name);

      if (libImportMode === "overwrite") {
        await replacePlaylistTracksBrowser(playlist.id, uris, token);
      } else {
        await addTracksBrowser(playlist.id, uris, token);
      }

      // Keep the local library CSV (used for BPM/pace matching) in step with
      // whatever just landed in the Spotify playlist — same append/overwrite mode.
      const header = "Track URI,Track Name,Artist Name(s)";
      const rows = matched.map(t => [t.uri, t.name, t.artistName].map(csvEscapeLocal).join(","));
      const csvBody = `${header}\n${rows.join("\n")}\n`;
      await fetch(`/api/save-default-playlist?mode=${libImportMode}`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: csvBody,
      });

      const noMatch = libTracks.length - uris.length;
      setLibSavedMsg(
        `${libImportMode === "overwrite" ? "Replaced" : "Added"} ${uris.length} track${uris.length !== 1 ? "s" : ""} in "${playlist.name}" (Spotify + local library)` +
        (noMatch > 0 ? ` · ${noMatch} not found on Spotify` : "")
      );
    } catch (e) {
      setLibError(e instanceof Error ? e.message : "Failed to save to Spotify");
    } finally {
      setLibSaving(false);
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
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-start">

    {/* ── Column 1: Heart Rate ── */}
    <div className="space-y-6">

      {/* Max HR / Resting HR */}
      <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 overflow-hidden">
        <div className="px-5 py-4 border-b border-white/10">
          <h2 className="font-semibold text-lg">Heart Rate Settings</h2>
        </div>
        <div className="p-5 space-y-5">
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-slate-300">Max Heart Rate</label>
          <p className="text-xs text-slate-500">Normally measured from a Max HR Stress Test.</p>
          <input
            type="number"
            min={100}
            max={220}
            value={maxHR || ""}
            onChange={e => handleMaxHR(e.target.value)}
            className="w-24 rounded-lg bg-slate-800/60 border border-white/10 text-lg px-3 py-2 text-slate-100 text-center focus:outline-none focus:ring-1 focus:ring-green-500"
          />
        </div>

        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-slate-300">Resting Heart Rate</label>
          <p className="text-xs text-slate-500">Measure first thing in the morning, standing still.</p>
          <input
            type="number"
            min={30}
            max={100}
            value={restingHR || ""}
            onChange={e => handleRestingHR(e.target.value)}
            className="w-24 rounded-lg bg-slate-800/60 border border-white/10 text-lg px-3 py-2 text-slate-100 text-center focus:outline-none focus:ring-1 focus:ring-green-500"
          />
        </div>

        {hrrValid && (
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
      {hrrValid && (
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
        </div>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <button
        onClick={save}
        disabled={saving || !hrrValid}
        className="rounded-lg bg-green-500 hover:bg-green-400 disabled:opacity-40 text-black font-semibold text-sm px-5 py-2 transition-colors"
      >
        {saving ? "Saving…" : saved ? "Saved!" : "Save zones"}
      </button>
    </div>

    {/* ── Column 2: BBC ── */}
    <div className="space-y-6">

      {/* Playlist Management */}
      <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 overflow-hidden">
        <div className="px-5 py-4 border-b border-white/10">
          <h2 className="font-semibold text-lg">Playlist Management</h2>
        </div>
        <div className="p-5 space-y-4">
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
                  onClick={saveCsvToPlaylist}
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
        </div>

        <div className="pt-3 border-t border-white/10 space-y-2">
          <label className="block text-sm font-medium text-slate-300">Import AI DJ playlist library</label>
          <p className="text-xs text-slate-500">
            Browse to a local library CSV (Track Name / Artist Name(s) columns) — each track is
            looked up on Spotify, then saved as the playlist you name below (created on Spotify if
            it doesn&apos;t exist yet, with a matching CSV file on the Pi).
          </p>
          <input
            type="text"
            value={libPlaylistName}
            onChange={e => { setLibPlaylistName(e.target.value); setLibError(null); }}
            placeholder="Playlist name (Spotify name + Pi filename)"
            className="w-full rounded-lg bg-slate-800/60 border border-white/10 text-sm px-3 py-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-green-500"
          />
          <div className="flex items-center gap-3 flex-wrap">
            <input ref={aiDjLibraryFileRef} type="file" accept=".csv" onChange={handleAiDjLibraryUpload} className="hidden" />
            <button
              onClick={() => aiDjLibraryFileRef.current?.click()}
              disabled={libLoading}
              className="inline-flex items-center gap-2 rounded-lg bg-slate-700/80 hover:bg-slate-600/80 disabled:opacity-40 text-slate-200 text-sm font-medium px-4 py-2 transition-colors"
            >
              {libLoading ? "Looking up…" : "Browse CSV"}
            </button>
          </div>

          {libLoading && libProgressTotal > 0 && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-slate-500">
                <span>Matching tracks on Spotify…</span>
                <span>{libProgress}/{libProgressTotal} · {Math.round((libProgress / libProgressTotal) * 100)}%</span>
              </div>
              <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-green-500 rounded-full transition-all duration-200"
                  style={{ width: `${Math.round((libProgress / libProgressTotal) * 100)}%` }}
                />
              </div>
            </div>
          )}

          {libError && <p className="text-xs text-red-400">{libError}</p>}

          {/* Nothing is written to disk or Spotify until Save is pressed here —
              this gives a chance to pick append/overwrite after seeing the match count */}
          {!libLoading && libTracks.length > 0 && (
            <div className="rounded-lg bg-slate-800/40 border border-white/10 p-3 space-y-2">
              <p className="text-xs text-slate-400">
                {libFileName} — {libTracks.filter(t => t.uri).length}/{libTracks.length} matched on Spotify
              </p>
              <div className="flex items-center gap-3 flex-wrap">
                <div className="inline-flex rounded-lg border border-white/10 overflow-hidden text-xs">
                  <button
                    onClick={() => setLibImportMode("append")}
                    className={`px-3 py-1.5 transition-colors ${libImportMode === "append" ? "bg-slate-600 text-white" : "bg-slate-800/60 text-slate-400 hover:text-slate-200"}`}
                  >
                    Append
                  </button>
                  <button
                    onClick={() => setLibImportMode("overwrite")}
                    className={`px-3 py-1.5 transition-colors ${libImportMode === "overwrite" ? "bg-slate-600 text-white" : "bg-slate-800/60 text-slate-400 hover:text-slate-200"}`}
                  >
                    Overwrite
                  </button>
                </div>
                <button
                  onClick={saveAiDjLibraryToPlaylist}
                  disabled={libSaving || !libPlaylistName.trim()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-green-500 hover:bg-green-400 disabled:opacity-40 text-black font-semibold text-xs px-3 py-1.5 transition-colors whitespace-nowrap"
                >
                  {libSaving ? "Saving…" : libImportMode === "overwrite" ? `Overwrite "${libPlaylistName || "…"}"` : `Add to "${libPlaylistName || "…"}"`}
                </button>
              </div>

              {libTracks.some(t => !t.uri) && (
                <div className="pt-2 border-t border-white/10 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-amber-400">
                      {libTracks.filter(t => !t.uri).length} not found on Spotify
                    </p>
                    <button
                      onClick={retryLibraryMisses}
                      disabled={libLoading}
                      className="text-xs rounded-lg bg-slate-700/80 hover:bg-slate-600/80 disabled:opacity-40 text-slate-200 px-2.5 py-1 transition-colors whitespace-nowrap"
                    >
                      {libLoading ? "Retrying…" : "Retry all misses"}
                    </button>
                  </div>
                  <div className="max-h-40 overflow-y-auto no-scrollbar rounded-lg border border-white/10 divide-y divide-white/5">
                    {libTracks.filter(t => !t.uri).map((t, i) => (
                      <div key={`${t.originalTitle}-${t.originalArtist}-${i}`} className="px-2.5 py-1.5 text-xs">
                        <span className="text-slate-300">{t.originalTitle}</span>
                        <span className="text-slate-500"> — {t.originalArtist}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {libSavedMsg && <p className="text-xs text-green-400">{libSavedMsg}</p>}
        </div>
        </div>
      </div>

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
            onClick={() => { if (!aiDjSaving && aiDjUrl.trim()) saveAiDj(!aiDjEnabled); }}
            disabled={aiDjSaving || !aiDjUrl.trim()}
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

    {/* ── Column 3: Runna + ntfy ── */}
    <div className="space-y-6">

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
