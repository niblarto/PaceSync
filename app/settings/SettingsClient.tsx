"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import type { RunningZone } from "@/types";
import { BbcBrowserCard } from "@/components/BbcBrowserCard";

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

  // ── CSV import state ───────────────────────────────────────────────────────
  const [csvFileName, setCsvFileName] = useState<string | null>(null);
  const [csvTrackCount, setCsvTrackCount] = useState<number | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [csvSaving, setCsvSaving] = useState(false);
  const [csvSaved, setCsvSaved] = useState(false);
  const csvFileRef = useRef<HTMLInputElement>(null);

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

  function openBrowser(mode: "add" | "replace", targetPid?: string, targetName?: string) {
    setBbcBrowserMode(mode);
    setBbcBrowserTargetPid(targetPid);
    setBbcBrowserTargetName(targetName);
    setBbcBrowserOpen(true);
    setBbcSaveMsg(null);
  }

  function handleCsvUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setCsvError(null);
    setCsvSaved(false);
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const text = ev.target?.result as string;
      // basic validation
      const lines = text.replace(/\r/g, "").split("\n").filter(Boolean);
      if (lines.length < 2) { setCsvError("File appears to be empty."); return; }
      const header = lines[0].toLowerCase();
      if (!header.includes("track") && !header.includes("name") && !header.includes("uri")) {
        setCsvError("Doesn't look like an Exportify CSV — check the file and try again."); return;
      }
      setCsvSaving(true);
      try {
        await fetch("/api/save-default-playlist", {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: text,
        });
        setCsvFileName(file.name);
        setCsvTrackCount(lines.length - 1);
        setCsvSaved(true);
      } catch {
        setCsvError("Failed to save — try again.");
      } finally {
        setCsvSaving(false);
      }
    };
    reader.readAsText(file);
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
      <div className="space-y-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-20 rounded-lg bg-slate-900 animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 items-start">

    {/* ── Left column: Heart Rate ── */}
    <div className="space-y-8">

      {/* ── Max HR / Resting HR ── */}
      <div className="space-y-5">
        <h2 className="font-semibold text-lg">Heart Rate Settings</h2>

        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-slate-300">
            Max Heart Rate
          </label>
          <p className="text-xs text-slate-500">Normally measured from a Max HR Stress Test.</p>
          <input
            type="number"
            min={100}
            max={220}
            value={maxHR || ""}
            onChange={e => handleMaxHR(e.target.value)}
            className="w-24 rounded-lg bg-slate-900 border border-slate-700 text-lg px-3 py-2 text-slate-100 text-center focus:outline-none focus:ring-1 focus:ring-green-500"
          />
        </div>

        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-slate-300">
            Resting Heart Rate
          </label>
          <p className="text-xs text-slate-500">Measure first thing in the morning, standing still.</p>
          <input
            type="number"
            min={30}
            max={100}
            value={restingHR || ""}
            onChange={e => handleRestingHR(e.target.value)}
            className="w-24 rounded-lg bg-slate-900 border border-slate-700 text-lg px-3 py-2 text-slate-100 text-center focus:outline-none focus:ring-1 focus:ring-green-500"
          />
        </div>

        {hrrValid && (
          <div className="rounded-lg bg-slate-900 border border-slate-800 px-4 py-3 space-y-0.5">
            <p className="text-sm text-slate-400">
              Heart Rate Reserve:{" "}
              <span className="text-white font-bold text-xl">{hrr}</span>
              <span className="ml-1.5 text-xs text-slate-500">bpm</span>
            </p>
            <p className="text-xs text-slate-600">This is how much your heart rate can vary.</p>
          </div>
        )}
      </div>

      {/* ── Zone summary ── */}
      {hrrValid && (
        <div className="space-y-3">
          <h3 className="font-semibold text-slate-300">Zone Summary</h3>
          <div className="rounded-xl bg-slate-900 border border-slate-800 overflow-hidden">
            {zones.map((z, i) => (
              <div key={i} className={`flex items-center gap-3 px-4 py-2.5 ${i < 4 ? "border-b border-slate-800" : ""}`}>
                <span className={`w-2 h-2 rounded-full shrink-0 ${ZONE_DETAILS[i].color}`} />
                <span className="text-sm text-slate-500 w-8 shrink-0">Z{i + 1}</span>
                <span className="text-sm text-slate-400 w-24 shrink-0">{ZONE_DETAILS[i].name}</span>
                <span className={`text-sm font-mono font-medium ${ZONE_DETAILS[i].colorText}`}>{zoneLabel(z, i)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Zone details + override ── */}
      <div className="space-y-4">
        <div className="flex items-baseline justify-between">
          <h3 className="font-semibold text-slate-300">Zone Details &amp; Override</h3>
          <button
            onClick={resetToCalc}
            className="text-xs text-slate-500 hover:text-slate-300 underline transition-colors"
          >
            Reset to calculated
          </button>
        </div>

        {zones.map((z, i) => (
          <div key={i} className={`rounded-xl bg-slate-900 border border-slate-800 ${ZONE_DETAILS[i].borderColor} overflow-hidden`}>
            <div className="flex items-center gap-2.5 px-4 py-3 border-b border-slate-800">
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
                    className="w-16 rounded bg-slate-800 border border-slate-700 text-sm px-2 py-1.5 text-slate-100 text-center focus:outline-none focus:ring-1 focus:ring-green-500"
                  />
                  <span className="text-xs text-slate-500">bpm</span>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    value={z.min || ""}
                    onChange={e => updateZone(i, "min", e.target.value)}
                    className="w-16 rounded bg-slate-800 border border-slate-700 text-sm px-2 py-1.5 text-slate-100 text-center focus:outline-none focus:ring-1 focus:ring-green-500"
                  />
                  <span className="text-xs text-slate-500">–</span>
                  <input
                    type="number"
                    value={z.max || ""}
                    onChange={e => updateZone(i, "max", e.target.value)}
                    className="w-16 rounded bg-slate-800 border border-slate-700 text-sm px-2 py-1.5 text-slate-100 text-center focus:outline-none focus:ring-1 focus:ring-green-500"
                  />
                  <span className="text-xs text-slate-500">bpm</span>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <button
        onClick={save}
        disabled={saving || !hrrValid}
        className="rounded-lg bg-green-500 hover:bg-green-400 disabled:opacity-40 text-black font-semibold text-sm px-5 py-2 transition-colors"
      >
        {saving ? "Saving…" : saved ? "Saved!" : "Save zones"}
      </button>

      {/* ── Runna Integration ── */}
      <div className="space-y-4 pt-4 border-t border-slate-800">
        <div>
          <h2 className="font-semibold text-lg">Runna Integration</h2>
          <p className="text-sm text-slate-400 mt-1">
            Connect your Runna training calendar to see upcoming workouts and zone suggestions on the dashboard.
          </p>
        </div>
        <div className="rounded-lg bg-slate-900 border border-slate-800 p-4 space-y-2 text-xs text-slate-400">
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
            className="w-full rounded-lg bg-slate-900 border border-slate-700 text-sm px-3 py-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-green-500"
          />
        </div>
        {runnaError && <p className="text-sm text-red-400">{runnaError}</p>}
        <button
          onClick={saveRunnaUrl}
          disabled={runnaSaving || !runnaUrl.trim()}
          className="rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-slate-200 font-medium text-sm px-5 py-2 transition-colors"
        >
          {runnaSaving ? "Saving…" : runnaSaved ? "Saved!" : "Save URL"}
        </button>
      </div>

    </div>

    {/* ── Right column: Import + BBC Programmes ── */}
    <div className="space-y-8">

      {/* ── Import Playlist ── */}
      <div className="space-y-4">
        <h2 className="font-semibold text-lg">Import Playlist</h2>
        <p className="text-sm text-slate-400">
          Export your Spotify playlist via{" "}
          <a href="https://exportify.net" target="_blank" rel="noopener noreferrer"
            className="text-green-400 hover:text-green-300 underline">
            exportify.net
          </a>
          , then upload the CSV here. It will be saved as your default Running playlist.
        </p>
        <ol className="text-xs text-slate-500 space-y-1 list-decimal list-inside">
          <li>Go to <span className="text-slate-300">exportify.net</span> and log in with Spotify</li>
          <li>Find your Running playlist and click <span className="text-slate-300">Export</span></li>
          <li>Upload the downloaded CSV below</li>
        </ol>
        <div className="flex items-center gap-3 flex-wrap">
          <input ref={csvFileRef} type="file" accept=".csv" onChange={handleCsvUpload} className="hidden" />
          <button
            onClick={() => csvFileRef.current?.click()}
            disabled={csvSaving}
            className="inline-flex items-center gap-2 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-slate-200 text-sm font-medium px-4 py-2 transition-colors"
          >
            {csvSaving ? "Saving…" : "Upload CSV"}
          </button>
          {csvSaved && csvFileName && (
            <span className="text-sm text-green-400">
              {csvFileName} saved — {csvTrackCount} tracks
            </span>
          )}
        </div>
        {csvError && <p className="text-sm text-red-400">{csvError}</p>}
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-lg">BBC Programmes</h2>
          {!bbcBrowserOpen && (
            <button
              onClick={() => openBrowser("add")}
              className="text-xs text-slate-400 hover:text-slate-200 border border-slate-700 rounded-lg px-3 py-1.5 transition-colors"
            >
              + Add Programme
            </button>
          )}
        </div>

        {bbcLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map(i => <div key={i} className="h-14 rounded-lg bg-slate-900 animate-pulse" />)}
          </div>
        ) : bbcProgrammes.length === 0 ? (
          <p className="text-sm text-slate-500">No BBC programmes configured.</p>
        ) : (
          <div className="space-y-2">
            {bbcProgrammes.map(p => (
              <div key={p.pid} className="flex items-center justify-between gap-2 rounded-lg bg-slate-900 border border-slate-800 px-4 py-3">
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

        {bbcSaveMsg && (
          <p className="text-sm text-green-400">{bbcSaveMsg}</p>
        )}

        {/* ── Run Now ── */}
        {!bbcBrowserOpen && (
          <div className="space-y-3 pt-1">
            <button
              onClick={runCronNow}
              disabled={cronRunning || bbcLoading}
              className="w-full rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 border border-slate-700 text-sm font-medium text-slate-200 px-4 py-2.5 transition-colors flex items-center justify-center gap-2"
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

            {cronError && (
              <p className="text-sm text-red-400">{cronError}</p>
            )}

            {cronResults && cronSummary && (
              <div className="rounded-lg bg-slate-900 border border-slate-800 overflow-hidden text-sm">
                {cronResults.map((r, i) => (
                  <div key={i} className={`flex items-center justify-between gap-3 px-4 py-2.5 ${i < cronResults.length - 1 ? "border-b border-slate-800" : ""}`}>
                    <span className={`truncate ${r.error ? "text-red-400" : "text-slate-300"}`}>{r.name}</span>
                    {r.error ? (
                      <span className="text-xs text-red-500 shrink-0">{r.error}</span>
                    ) : (
                      <span className="text-xs text-slate-500 shrink-0 tabular-nums">{r.matched} / {r.found} songs added</span>
                    )}
                  </div>
                ))}
                <div className="px-4 py-2.5 bg-slate-800/50 border-t border-slate-700 flex items-center justify-between">
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
    </div>
  );
}

