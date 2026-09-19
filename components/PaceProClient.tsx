"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { MixPaceChart, timelineToChartTracks } from "@/components/MixPaceChart";
import { RouteMapLightbox } from "@/components/RouteMapLightbox";
import { parsePaceProCsv, paceProSplitsToSegments, totalDistanceMi, totalDurationSec, fmtPaceSec, type PaceProSplit } from "@/lib/pace-pro";

// Local mirror of lib/ai-dj-mix.ts's AiDjMixResponse shape (server-only
// module — not imported client-side) for parsing the mix-build SSE stream.
interface AiDjSimTrack { uri: string; name: string; artist: string; startsAt: string; durationSec?: number; tempo: number }
interface AiDjSimTimelineSegment { segment: string; targetPaceSec?: number | null; tracks: AiDjSimTrack[] }
interface AiDjMixResponse { trackUris: string[]; totalSec: number; timeline: AiDjSimTimelineSegment[]; llmFailures?: string[] }

// Local mirror of lib/pace-pro-saved.ts's SavedPaceProMix.
interface SavedPaceProMix {
  id: string; title: string; totalSec: number; timeline: AiDjSimTimelineSegment[];
  splitsCsvText: string; fileName: string | null; savedAt: string; activityId: string | null;
}

export function PaceProClient() {
  const [ppFileName, setPpFileName] = useState<string | null>(null);
  const [ppSplits, setPpSplits] = useState<PaceProSplit[] | null>(null);
  const [ppParseError, setPpParseError] = useState<string | null>(null);
  const [ppTitle, setPpTitle] = useState("Pace Pro Run");
  const [ppBuilding, setPpBuilding] = useState(false);
  const [ppProgress, setPpProgress] = useState<{ current: number; total: number; segment: string; detail?: string } | null>(null);
  const [ppMix, setPpMix] = useState<AiDjMixResponse | null>(null);
  const [ppTrackUris, setPpTrackUris] = useState<string[]>([]);
  const [ppError, setPpError] = useState<string | null>(null);
  const [ppSaving, setPpSaving] = useState(false);
  const [ppSaveMsg, setPpSaveMsg] = useState<string | null>(null);
  // Decoded CSV text, kept around so a successful build can be pinned
  // server-side with enough to fully restore the splits table on reload —
  // not just the built mix.
  const [ppCsvText, setPpCsvText] = useState<string | null>(null);
  const [ppPinLoaded, setPpPinLoaded] = useState(false);
  const [ppPinnedAt, setPpPinnedAt] = useState<string | null>(null);
  const [ppImageTranscribing, setPpImageTranscribing] = useState(false);
  // Saved Pace Pro mix library — distinct from the single-slot pin above:
  // these persist until explicitly deleted, and there can be many.
  const [ppSavedMixes, setPpSavedMixes] = useState<SavedPaceProMix[]>([]);
  const [ppSavedLoaded, setPpSavedLoaded] = useState(false);
  const [ppSavingToLibrary, setPpSavingToLibrary] = useState(false);
  const [ppLibraryMsg, setPpLibraryMsg] = useState<string | null>(null);
  const [ppLoadedSavedId, setPpLoadedSavedId] = useState<string | null>(null);
  // Attaching a GarminDB activity (map + segment/track breakdown, via the
  // same RouteMapLightbox a Runna workout's pinned route uses) to a saved
  // Pace Pro mix — keyed by the mix's own id, not a synthetic date/title.
  const [ppActivityInputs, setPpActivityInputs] = useState<Record<string, string>>({});
  const [ppAttachingId, setPpAttachingId] = useState<string | null>(null);
  const [ppRouteMapMix, setPpRouteMapMix] = useState<SavedPaceProMix | null>(null);

  // Restore the last pinned Pace Pro mix and the saved-mix library on mount.
  useEffect(() => {
    if (!ppPinLoaded) {
      setPpPinLoaded(true);
      fetch("/api/settings/pace-pro-pin")
        .then(r => r.json())
        .then((d: { pin?: { title: string; totalSec: number; timeline: AiDjMixResponse["timeline"]; splitsCsvText: string; fileName: string | null; pinnedAt: string } | null }) => {
          if (!d.pin) return;
          const parsed = parsePaceProCsv(d.pin.splitsCsvText);
          if (parsed.ok) setPpSplits(parsed.splits);
          setPpCsvText(d.pin.splitsCsvText);
          setPpFileName(d.pin.fileName);
          setPpTitle(d.pin.title);
          setPpMix({ trackUris: d.pin.timeline.flatMap(s => s.tracks.map(t => t.uri)), totalSec: d.pin.totalSec, timeline: d.pin.timeline });
          setPpTrackUris(d.pin.timeline.flatMap(s => s.tracks.map(t => t.uri)));
          setPpPinnedAt(d.pin.pinnedAt);
        })
        .catch(() => {});
    }
    if (!ppSavedLoaded) {
      setPpSavedLoaded(true);
      fetch("/api/settings/pace-pro-saved")
        .then(r => r.json())
        .then((d: { mixes?: SavedPaceProMix[] }) => setPpSavedMixes(d.mixes ?? []))
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Shared by file-upload and paste-screenshot: given already-decoded CSV
  // text (real PacePro export, or a vision model's transcription of one),
  // parse it and reset every downstream build/result/save state, same as a
  // fresh file choice — the user is starting over with new splits either way.
  function applyPaceProCsvText(text: string, defaultTitle: string) {
    setPpParseError(null);
    setPpMix(null);
    setPpTrackUris([]);
    setPpError(null);
    setPpSaveMsg(null);
    setPpLoadedSavedId(null);
    setPpLibraryMsg(null);
    if (!ppTitle || ppTitle === "Pace Pro Run") {
      setPpTitle(defaultTitle);
    }
    const parsed = parsePaceProCsv(text);
    if (!parsed.ok) {
      setPpParseError(parsed.error);
      setPpSplits(null);
      return;
    }
    setPpSplits(parsed.splits);
    setPpCsvText(text);
  }

  function handlePaceProFile(file: File) {
    setPpFileName(file.name);
    // Garmin's PacePro export uses a non-breaking space (0xA0) before units
    // ("1.02 mi", "8:28 /mi"), encoded as Windows-1252/Latin-1 — reading it
    // as UTF-8 (the default) turns that byte into U+FFFD, which then fails
    // to match \s in the distance/pace regexes and breaks every row.
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const buf = reader.result as ArrayBuffer;
        const text = new TextDecoder("windows-1252").decode(buf);
        applyPaceProCsvText(text, file.name.replace(/\.csv$/i, "") || "Pace Pro Run");
      } catch (e) {
        setPpParseError(e instanceof Error ? e.message : "Could not read the file.");
        setPpSplits(null);
      }
    };
    reader.onerror = () => setPpParseError("Could not read the file.");
    reader.readAsArrayBuffer(file);
  }

  // arrayBuffer -> base64 without a data: URI wrapper (Ollama's /api/chat
  // images field wants raw base64).
  function arrayBufferToBase64(buf: ArrayBuffer): string {
    let binary = "";
    const bytes = new Uint8Array(buf);
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
    }
    return btoa(binary);
  }

  async function handlePaceProImage(blob: Blob) {
    setPpImageTranscribing(true);
    setPpParseError(null);
    try {
      const buf = await blob.arrayBuffer();
      const base64 = arrayBufferToBase64(buf);
      const res = await fetch("/api/settings/pace-pro-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: base64 }),
      });
      const data = await res.json() as { csv?: string; error?: string };
      if (!res.ok || data.error || !data.csv) {
        setPpParseError(data.error ?? `Screenshot transcription failed (${res.status})`);
        return;
      }
      setPpFileName("Pasted screenshot");
      applyPaceProCsvText(data.csv, "Pace Pro Run");
    } catch (e) {
      setPpParseError(e instanceof Error ? e.message : "Screenshot transcription failed");
    } finally {
      setPpImageTranscribing(false);
    }
  }

  async function buildPaceProMix() {
    if (!ppSplits?.length) return;
    const segments = paceProSplitsToSegments(ppSplits);
    setPpBuilding(true);
    setPpMix(null);
    setPpTrackUris([]);
    setPpError(null);
    setPpProgress(null);
    setPpLoadedSavedId(null);
    setPpLibraryMsg(null);
    try {
      // For each split, get the exact same "fits" URI list the Pace
      // Analysis tab would show for that pace (confirmed-play tracks
      // classified by the app's own tolerance rule) — these become the
      // candidates the LLM picks from for that split, falling back to the
      // normal (still tolerance-filtered) whole-library search only if a
      // split's fit list can't fill its own time budget on its own.
      let segmentCandidateUris: (string[] | null)[] | undefined;
      try {
        const paceRes = await fetch("/api/settings/pace-analysis-batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paceSecs: ppSplits.map(s => s.paceSec) }),
        });
        const paceData = await paceRes.json() as { results?: { paceSec: number; uris: string[] }[]; error?: string };
        if (paceRes.ok && paceData.results) {
          segmentCandidateUris = paceData.results.map(r => r.uris);
        }
      } catch {
        // Pace Analysis lookup is best-effort — a failure here just means
        // the build falls back to the normal strictPaceTolerance-filtered
        // whole-library search for every split, not a hard error.
      }

      const res = await fetch("/api/ai-dj/mix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // strictPaceTolerance: whichever split falls back past
        // segmentCandidateUris still gets the same ±3 BPM (no-upper-limit)
        // rule the Pace Analysis tab judges "fits" by, instead of the
        // mixer's normal progressive BPM-tolerance widening.
        body: JSON.stringify({
          title: ppTitle.trim() || "Pace Pro Run", segments,
          strictPaceTolerance: true, segmentCandidateUris,
        }),
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? `Build failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const dataLine = chunk.split("\n").find(l => l.startsWith("data: "));
          if (!dataLine) continue;
          const msg = JSON.parse(dataLine.slice(6)) as
            & Partial<AiDjMixResponse>
            & { type: string; current?: number; total?: number; segment?: string; detail?: string; error?: string };
          if (msg.type === "progress") {
            setPpProgress({ current: msg.current ?? 0, total: msg.total ?? 1, segment: msg.segment ?? "", detail: msg.detail });
          } else if (msg.type === "error") {
            setPpError(msg.error ?? "Build failed");
          } else if (msg.type === "done") {
            const mix = { trackUris: msg.trackUris ?? [], totalSec: msg.totalSec ?? 0, timeline: msg.timeline ?? [] };
            setPpMix(mix);
            setPpTrackUris(msg.trackUris ?? []);
            void pinPaceProMix(mix);
          }
        }
      }
    } catch (e) {
      setPpError(e instanceof Error ? e.message : "Build failed");
    } finally {
      setPpBuilding(false);
      setPpProgress(null);
    }
  }

  // Pins the just-built mix server-side so it survives a reload/different
  // browser, replacing whatever was pinned before — Pace Pro only ever
  // keeps its one most-recent mix, unlike a real workout's per-date pin.
  async function pinPaceProMix(mix: AiDjMixResponse) {
    if (!ppCsvText) return;
    try {
      await fetch("/api/settings/pace-pro-pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: ppTitle.trim() || "Pace Pro Run",
          totalSec: mix.totalSec,
          timeline: mix.timeline,
          splitsCsvText: ppCsvText,
          fileName: ppFileName,
        }),
      });
      setPpPinnedAt(new Date().toISOString());
    } catch {
      // Best-effort — the build itself already succeeded and is showing on
      // the page; a failed pin just means it won't survive a reload.
    }
  }

  async function unpinPaceProMix() {
    try {
      await fetch("/api/settings/pace-pro-pin", { method: "DELETE" });
    } catch { /* best-effort */ }
    setPpPinnedAt(null);
  }

  // Saves the currently-built mix into the named library (distinct from the
  // single-slot pin) — updates in place if this mix was itself loaded from
  // the library, otherwise adds a new entry.
  async function savePaceProToLibrary() {
    if (!ppMix || !ppCsvText) return;
    setPpSavingToLibrary(true);
    setPpLibraryMsg(null);
    try {
      const res = await fetch("/api/settings/pace-pro-saved", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: ppLoadedSavedId ?? undefined,
          title: ppTitle.trim() || "Pace Pro Run",
          totalSec: ppMix.totalSec,
          timeline: ppMix.timeline,
          splitsCsvText: ppCsvText,
          fileName: ppFileName,
        }),
      });
      const data = await res.json() as { mix?: SavedPaceProMix; error?: string };
      if (!res.ok || data.error || !data.mix) throw new Error(data.error ?? `Save failed (${res.status})`);
      setPpLoadedSavedId(data.mix.id);
      setPpSavedMixes(prev => [data.mix!, ...prev.filter(m => m.id !== data.mix!.id)]);
      setPpLibraryMsg(`Saved "${data.mix.title}"`);
    } catch (e) {
      setPpLibraryMsg(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setPpSavingToLibrary(false);
    }
  }

  function loadSavedPaceProMix(mix: SavedPaceProMix) {
    const parsed = parsePaceProCsv(mix.splitsCsvText);
    if (parsed.ok) setPpSplits(parsed.splits);
    setPpCsvText(mix.splitsCsvText);
    setPpFileName(mix.fileName);
    setPpTitle(mix.title);
    setPpMix({ trackUris: mix.timeline.flatMap(s => s.tracks.map(t => t.uri)), totalSec: mix.totalSec, timeline: mix.timeline });
    setPpTrackUris(mix.timeline.flatMap(s => s.tracks.map(t => t.uri)));
    setPpLoadedSavedId(mix.id);
    setPpLibraryMsg(null);
    setPpParseError(null);
    setPpError(null);
  }

  async function deleteSavedPaceProMix(id: string) {
    setPpSavedMixes(prev => prev.filter(m => m.id !== id));
    if (ppLoadedSavedId === id) setPpLoadedSavedId(null);
    try {
      await fetch(`/api/settings/pace-pro-saved?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch { /* best-effort — already removed from the list */ }
  }

  // Attaches a GarminDB activity (by id, e.g. the numeric id in
  // https://connect.garmin.com/app/activity/<id>) as a saved Pace Pro mix's
  // route/map — no live Garmin Connect lookup here; the id only resolves
  // once RouteMapLightbox itself queries /api/garmin/route/[id], which reads
  // GarminDB's local synced database, so an activity Garmin hasn't synced
  // down yet will show "No GPS data" there rather than failing this call.
  async function attachPaceProActivity(mixId: string) {
    const activityId = (ppActivityInputs[mixId] ?? "").trim();
    if (!activityId) return;
    setPpAttachingId(mixId);
    try {
      const res = await fetch("/api/settings/pace-pro-saved/activity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: mixId, activityId }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `Failed (${res.status})`);
      setPpSavedMixes(prev => prev.map(m => m.id === mixId ? { ...m, activityId } : m));
      setPpActivityInputs(prev => { const next = { ...prev }; delete next[mixId]; return next; });
    } catch (e) {
      setPpLibraryMsg(e instanceof Error ? e.message : "Failed to attach activity");
    } finally {
      setPpAttachingId(null);
    }
  }

  async function detachPaceProActivity(mixId: string) {
    setPpSavedMixes(prev => prev.map(m => m.id === mixId ? { ...m, activityId: null } : m));
    try {
      await fetch("/api/settings/pace-pro-saved/activity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: mixId, activityId: null }),
      });
    } catch { /* best-effort */ }
  }

  // Hands the built mix off to the main dashboard's track list for full
  // editing (remove track, remix, fill-the-gap) — the dashboard has no
  // notion of a Pace Pro mix, so this is shaped exactly like a real Runna
  // workout's AI DJ mix (segments/timeline), pinned under a synthetic
  // (date, title) key so remix/gap-fill on the dashboard side, plus a
  // sessionStorage handoff (the payload is too big/structured for a URL
  // param) that DashboardClient reads once on ?loadPaceProMix=1 and clears.
  function sendPaceProMixToDashboard() {
    if (!ppMix || !ppSplits?.length || !ppCsvText) return;
    const title = ppTitle.trim() || "Pace Pro Run";
    const date = new Date().toISOString().slice(0, 10);
    const segments = paceProSplitsToSegments(ppSplits);
    try {
      sessionStorage.setItem("paceProDashboardHandoff", JSON.stringify({
        workoutTitle: title, date, totalSec: ppMix.totalSec, timeline: ppMix.timeline, segments,
        splitsCsvText: ppCsvText, fileName: ppFileName, savedMixId: ppLoadedSavedId,
      }));
    } catch {
      setPpError("Could not hand off this mix to the dashboard (browser storage unavailable).");
      return;
    }
    window.location.href = "/dashboard?loadPaceProMix=1";
  }

  // Same "Today's Run" playlist every other mix save (real or simulated)
  // uses — find-or-create by name, replace its tracks.
  async function savePaceProToSpotify() {
    if (!ppTrackUris.length) return;
    setPpSaving(true);
    setPpSaveMsg(null);
    try {
      const res = await fetch("/api/spotify/create-playlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Today's Run",
          description: `Pace Pro mix (${ppTitle.trim() || "Pace Pro Run"}) from Settings → Pace Pro`,
          trackUris: ppTrackUris,
        }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `Save failed (${res.status})`);
      setPpSaveMsg(`Saved ${ppTrackUris.length} track${ppTrackUris.length !== 1 ? "s" : ""} to "Today's Run" on Spotify`);
    } catch (e) {
      setPpSaveMsg(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setPpSaving(false);
    }
  }

  return (
    <div
      className="min-h-screen flex flex-col bg-cover bg-fixed bg-center bg-no-repeat bg-slate-950 text-slate-100"
      style={{ backgroundImage: "linear-gradient(rgba(2,6,23,0.75), rgba(2,6,23,0.75)), url('/dashboard-hero.png')" }}
    >
      <header className="border-b border-white/5 bg-slate-950/70 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <Link href="/dashboard" className="text-sm text-slate-500 hover:text-slate-300 transition-colors">
            ← Dashboard
          </Link>
          <span className="font-bold text-green-400 text-lg tracking-tight">Pace Pro</span>
          <div />
        </div>
      </header>

      <div className="flex-1 max-w-5xl w-full mx-auto px-4 py-6 space-y-6">

      <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5 space-y-4">
        <div>
          <h2 className="font-semibold text-base">Pace Pro</h2>
          <p className="text-sm text-slate-400 mt-1">
            Upload a Garmin PacePro split plan (CSV export: Splits, Split Distance, Split Pace), or
            paste a screenshot of one, and build a pace-matched track listing for it — the same way
            as any other AI DJ mix, just sourced from your race pacing strategy instead of a Runna
            workout.
          </p>
        </div>

        <div className="space-y-2">
          <label className="block text-sm font-medium text-slate-300">PacePro CSV or screenshot</label>
          <div className="flex items-center gap-3 flex-wrap">
            <label className="rounded-lg bg-slate-700/80 hover:bg-slate-600/80 text-slate-200 font-medium text-sm px-4 py-2 transition-colors cursor-pointer">
              Choose file
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={e => { const f = e.target.files?.[0]; if (f) handlePaceProFile(f); e.target.value = ""; }}
                className="hidden"
              />
            </label>
            <div
              tabIndex={0}
              onPaste={e => {
                const item = Array.from(e.clipboardData.items).find(i => i.type.startsWith("image/"));
                const file = item?.getAsFile();
                if (file) { e.preventDefault(); void handlePaceProImage(file); }
              }}
              className="rounded-lg bg-slate-800/60 border border-dashed border-white/15 text-slate-400 text-sm px-4 py-2 focus:outline-none focus:ring-1 focus:ring-green-500 cursor-text select-none"
              title="Click here, then Ctrl+V to paste a screenshot"
            >
              {ppImageTranscribing ? "Reading screenshot…" : "Click here, then paste (Ctrl+V) a screenshot"}
            </div>
            {ppFileName && <span className="text-sm text-slate-400 truncate">{ppFileName}</span>}
          </div>
          {ppParseError && <p className="text-sm text-red-400">{ppParseError}</p>}
        </div>

        {ppSplits && ppSplits.length > 0 && (
          <>
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-slate-300">Mix title</label>
              <input
                type="text"
                value={ppTitle}
                onChange={e => setPpTitle(e.target.value)}
                className="w-full sm:w-80 rounded-lg bg-slate-800/60 border border-white/10 text-sm px-3 py-2 text-slate-100 focus:outline-none focus:ring-1 focus:ring-green-500"
              />
            </div>

            <div className="rounded-lg bg-slate-800/50 border border-white/5 p-3 space-y-2">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
                <span>{ppSplits.length} splits</span>
                <span>{totalDistanceMi(ppSplits).toFixed(2)} mi total</span>
                <span>{Math.round(totalDurationSec(ppSplits) / 60)} min at plan pace</span>
              </div>
              <div className="max-h-40 overflow-y-auto no-scrollbar divide-y divide-white/5 font-mono text-xs">
                {ppSplits.map(s => (
                  <div key={s.splitNum} className="flex items-center justify-between py-1">
                    <span className="text-slate-500">#{s.splitNum}</span>
                    <span className="text-slate-300">{s.distanceMi.toFixed(2)} mi</span>
                    <span className="text-green-400/90">{fmtPaceSec(s.paceSec)} /mi</span>
                  </div>
                ))}
              </div>
            </div>

            <button
              onClick={buildPaceProMix}
              disabled={ppBuilding}
              className="rounded-lg bg-green-500 hover:bg-green-400 disabled:opacity-40 text-black font-semibold text-sm px-4 py-1.5 transition-colors"
            >
              {ppBuilding ? "Building…" : "Build track listing"}
            </button>

            {ppBuilding && ppProgress && (
              <div className="rounded-lg bg-slate-800/50 border border-white/5 p-3 space-y-1 text-xs">
                <p className="text-slate-300">
                  Segment {ppProgress.current} of {ppProgress.total}: {ppProgress.segment}
                </p>
                {ppProgress.detail && <p className="text-slate-500 truncate">{ppProgress.detail}</p>}
              </div>
            )}
            {ppError && <p className="text-sm text-red-400">{ppError}</p>}
          </>
        )}
      </div>

      {ppMix && ppMix.timeline.length > 0 && (
        <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-slate-200">
              {ppTrackUris.length} tracks <span className="text-slate-500 font-normal">· {Math.round(ppMix.totalSec / 60)} min</span>
            </h3>
            <div className="flex items-center gap-3">
              <button
                onClick={sendPaceProMixToDashboard}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-500/15 border border-blue-500/40 hover:bg-blue-500/25 text-blue-300 font-medium text-xs px-3 py-1.5 transition-colors"
                title="Open this mix in the main dashboard track list to edit, remix, or fill gaps"
              >
                Send to dashboard
              </button>
              <button
                onClick={savePaceProToLibrary}
                disabled={ppSavingToLibrary}
                className="inline-flex items-center gap-2 rounded-lg bg-purple-500/15 border border-purple-500/40 hover:bg-purple-500/25 text-purple-300 font-medium text-xs px-3 py-1.5 transition-colors disabled:opacity-40"
              >
                {ppSavingToLibrary ? "Saving…" : ppLoadedSavedId ? "Update saved" : "Save to library"}
              </button>
              <button
                onClick={savePaceProToSpotify}
                disabled={ppSaving}
                className="inline-flex items-center gap-2 rounded-lg bg-green-500/15 border border-green-500/40 hover:bg-green-500/25 text-green-300 font-medium text-xs px-3 py-1.5 transition-colors disabled:opacity-40"
              >
                {ppSaving ? "Saving…" : `Save to Spotify ("Today's Run")`}
              </button>
            </div>
          </div>
          {ppLibraryMsg && <p className="text-xs text-slate-400">{ppLibraryMsg}</p>}
          {ppPinnedAt && (
            <div className="flex items-center gap-2 text-xs text-purple-300">
              <span>📌</span>
              <span>Pinned — this mix will still be here next time you open this page</span>
              <button onClick={unpinPaceProMix} className="text-slate-500 hover:text-red-400 underline transition-colors">
                Unpin
              </button>
            </div>
          )}
          {ppSaveMsg && <p className="text-xs text-slate-400">{ppSaveMsg}</p>}
          {ppMix.llmFailures && ppMix.llmFailures.length > 0 && (
            <p className="text-xs text-amber-400">
              {ppMix.llmFailures.length} segment{ppMix.llmFailures.length !== 1 ? "s" : ""} fell back to deterministic BPM matching (LLM call failed).
            </p>
          )}

          <MixPaceChart tracks={timelineToChartTracks(ppMix.timeline)} />

          <div className="rounded-lg border border-white/10 divide-y divide-white/5 font-mono text-xs max-h-96 overflow-y-auto no-scrollbar">
            {ppMix.timeline.flatMap(s => s.tracks).map((t, i) => (
              <div key={`${t.uri}-${i}`} className="px-3 py-1.5 flex items-center justify-between gap-3">
                <span className="text-slate-300 truncate">{t.name} — <span className="text-slate-500">{t.artist}</span></span>
                <span className="text-slate-400 shrink-0">{t.tempo.toFixed(1)} BPM</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {ppSavedMixes.length > 0 && (
        <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5 space-y-3">
          <h3 className="font-semibold text-slate-200">Saved Pace Pro mixes</h3>
          <div className="rounded-lg border border-white/10 divide-y divide-white/5">
            {ppSavedMixes.map(mix => (
              <div key={mix.id} className="px-3 py-2.5 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <button
                    onClick={() => loadSavedPaceProMix(mix)}
                    className={`text-left min-w-0 flex-1 group ${ppLoadedSavedId === mix.id ? "cursor-default" : "cursor-pointer"}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className={`text-sm font-medium truncate ${ppLoadedSavedId === mix.id ? "text-purple-300" : "text-slate-200 group-hover:text-green-300"}`}>
                        {mix.title}
                      </span>
                      {ppLoadedSavedId === mix.id && <span className="text-[10px] uppercase tracking-wide text-purple-400 shrink-0">loaded</span>}
                    </div>
                    <div className="text-xs text-slate-500">
                      {mix.timeline.flatMap(s => s.tracks).length} tracks · {Math.round(mix.totalSec / 60)} min · saved {new Date(mix.savedAt).toLocaleDateString()}
                    </div>
                  </button>
                  <button
                    onClick={() => deleteSavedPaceProMix(mix.id)}
                    className="text-slate-500 hover:text-red-400 text-xs shrink-0 transition-colors"
                  >
                    Delete
                  </button>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  {mix.activityId ? (
                    <>
                      <button
                        onClick={() => setPpRouteMapMix(mix)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-sky-500/40 bg-sky-500/15 hover:bg-sky-500/25 text-sky-300 text-xs px-2.5 py-1 transition-colors"
                      >
                        🗺️ View map &amp; segments
                      </button>
                      <button
                        onClick={() => detachPaceProActivity(mix.id)}
                        className="text-slate-500 hover:text-red-400 text-xs transition-colors"
                      >
                        Remove route
                      </button>
                    </>
                  ) : (
                    <>
                      <input
                        type="text"
                        value={ppActivityInputs[mix.id] ?? ""}
                        onChange={e => setPpActivityInputs(prev => ({ ...prev, [mix.id]: e.target.value }))}
                        onKeyDown={e => { if (e.key === "Enter") void attachPaceProActivity(mix.id); }}
                        placeholder="Garmin activity ID"
                        className="w-40 rounded-lg bg-slate-800/60 border border-white/10 text-xs px-2.5 py-1 text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-green-500 font-mono"
                      />
                      <button
                        onClick={() => attachPaceProActivity(mix.id)}
                        disabled={ppAttachingId === mix.id || !(ppActivityInputs[mix.id] ?? "").trim()}
                        className="rounded-lg bg-slate-700/80 hover:bg-slate-600/80 disabled:opacity-40 text-slate-200 text-xs px-2.5 py-1 transition-colors"
                        title="From connect.garmin.com/app/activity/<id> — must already be synced into GarminDB"
                      >
                        {ppAttachingId === mix.id ? "Attaching…" : "Attach route"}
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {ppRouteMapMix && (() => {
        const parsed = parsePaceProCsv(ppRouteMapMix.splitsCsvText);
        return (
          <RouteMapLightbox
            activityId={ppRouteMapMix.activityId!}
            label={ppRouteMapMix.title}
            workoutSegments={parsed.ok ? paceProSplitsToSegments(parsed.splits) : undefined}
            mixTracks={ppRouteMapMix.timeline.flatMap(s => s.tracks).map(t => {
              const [mm, ss] = t.startsAt.split(":").map(Number);
              return { uri: t.uri, name: t.name, artist: t.artist, startsAtSec: (mm || 0) * 60 + (ss || 0), durationSec: t.durationSec, tempo: t.tempo };
            })}
            onClose={() => setPpRouteMapMix(null)}
          />
        );
      })()}

      </div>
    </div>
  );
}
