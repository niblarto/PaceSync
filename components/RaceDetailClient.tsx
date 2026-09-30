"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { InlineRouteMap } from "./InlineRouteMap";
import { parsePaceProCsv, paceProSplitsToSegments } from "@/lib/pace-pro";

// Dashboard -> Races -> one race's own page. Route/course display and Pace
// Pro linking (moved OFF the main Races list per explicit request) live
// here. See lib/races.ts's own doc comment for why races are a durable,
// separate table rather than a live re-derivation from Runna/GarminDB.

type RaceStatus = "upcoming" | "completed";

interface Race {
  id: string;
  name: string;
  raceDate: string | null;
  status: RaceStatus;
  garminActivityId: string | null;
  runnaUid: string | null;
  paceProMixId: string | null;
  distanceMi: number | null;
  notes: string | null;
  garminCourseId: string | null;
  garminCourseName: string | null;
}

interface GarminActivitySummary {
  activity_id: string | number;
  name: string | null;
  sport: string | null;
  start_time: string;
  distance: number | null;
}

interface SavedPaceProMixSummary {
  id: string;
  title: string;
  totalSec: number;
  timeline: { segment: string; targetBpm: number | null; targetPaceSec?: number | null; tracks: { uri: string; name: string; artist: string; startsAt: string; durationSec?: number; tempo: number; energy: number }[] }[];
  splitsCsvText: string;
  fileName: string | null;
}

interface MapMixTrack {
  uri: string | null; name: string; artist: string; startsAtSec: number; durationSec?: number; tempo: number | null;
}

function fmtDate(d: string | null): string {
  if (!d) return "No date set";
  return new Date(`${d}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

// Accepts a full Garmin Connect course URL ("https://connect.garmin.com/
// app/course/25436796" or the older .../modern/course/25436796 form) or a
// bare numeric id typed directly, per explicit request ("I will provide a
// URL or course ID").
function parseCourseIdInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const m = trimmed.match(/\/course\/(\d+)/);
  return m ? m[1] : null;
}

export function RaceDetailClient({ id }: { id: string }) {
  const [race, setRace] = useState<Race | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDate, setEditDate] = useState("");
  const [editDistance, setEditDistance] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [linkedMix, setLinkedMix] = useState<SavedPaceProMixSummary | null>(null);

  const [linkingActivity, setLinkingActivity] = useState(false);
  const [activityFilter, setActivityFilter] = useState("");
  const [activities, setActivities] = useState<GarminActivitySummary[] | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);

  const [courseInput, setCourseInput] = useState("");
  const [courseBusy, setCourseBusy] = useState(false);
  const [courseError, setCourseError] = useState<string | null>(null);

  const [linkingPaceProMix, setLinkingPaceProMix] = useState(false);
  const [paceProLibrary, setPaceProLibrary] = useState<SavedPaceProMixSummary[] | null>(null);
  const [paceProLinkBusy, setPaceProLinkBusy] = useState(false);
  const [sendingToDashboard, setSendingToDashboard] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  function load() {
    fetch(`/api/races/${id}`)
      .then(r => r.json())
      .then((d: { race?: Race; error?: string }) => {
        if (d.error || !d.race) { setError(d.error ?? "Race not found"); return; }
        setRace(d.race);
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, [id]);

  // Full mix data (segments for the map's left panel, tracklist for the
  // right panel) — separate from the lightweight library list `paceProLibrary`
  // fetches for the picker, since that one doesn't include `timeline`/`splitsCsvText`.
  useEffect(() => {
    if (!race?.paceProMixId) { setLinkedMix(null); return; }
    let cancelled = false;
    fetch(`/api/settings/pace-pro-saved?id=${encodeURIComponent(race.paceProMixId)}`)
      .then(r => r.json())
      .then((d: { mix?: SavedPaceProMixSummary }) => { if (!cancelled) setLinkedMix(d.mix ?? null); })
      .catch(() => { if (!cancelled) setLinkedMix(null); });
    return () => { cancelled = true; };
  }, [race?.paceProMixId]);

  function startEdit() {
    if (!race) return;
    setEditName(race.name);
    setEditDate(race.raceDate ?? "");
    setEditDistance(race.distanceMi != null ? String(race.distanceMi) : "");
    setEditNotes(race.notes ?? "");
    setEditError(null);
    setEditing(true);
  }

  async function saveEdit() {
    if (!race || !editName.trim()) return;
    setEditBusy(true);
    setEditError(null);
    try {
      const res = await fetch(`/api/races/${race.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editName.trim(),
          raceDate: editDate || null,
          distanceMi: editDistance ? parseFloat(editDistance) : null,
          notes: editNotes.trim() || null,
        }),
      });
      const d = await res.json() as { race?: Race; error?: string };
      if (!res.ok || d.error || !d.race) throw new Error(d.error ?? "Failed to save");
      setRace(d.race);
      setEditing(false);
    } catch (e) {
      setEditError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setEditBusy(false);
    }
  }

  function loadActivities() {
    if (activities !== null) return;
    fetch("/api/garmin/data")
      .then(r => r.json())
      .then((d: { activities?: GarminActivitySummary[]; error?: string }) => {
        if (d.error) { setActivities([]); return; }
        setActivities((d.activities ?? []).filter(a => (a.sport ?? "").toLowerCase().includes("running")));
      })
      .catch(() => setActivities([]));
  }

  function openActivityPicker() {
    setLinkingActivity(true);
    loadActivities();
  }

  async function linkActivity(activityId: string | number) {
    if (!race) return;
    setLinkBusy(true);
    try {
      const res = await fetch(`/api/races/${race.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ garminActivityId: String(activityId) }),
      });
      const d = await res.json() as { race?: Race; error?: string };
      if (!res.ok || d.error || !d.race) throw new Error(d.error ?? "Failed to link activity");
      setRace(d.race);
      setLinkingActivity(false);
    } catch { /* picker stays open so the user can retry */ } finally {
      setLinkBusy(false);
    }
  }

  async function unlinkActivity() {
    if (!race) return;
    setRace(prev => prev && { ...prev, garminActivityId: null });
    try {
      await fetch(`/api/races/${race.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ garminActivityId: null }),
      });
    } catch { /* best-effort */ }
  }

  async function linkCourse() {
    if (!race) return;
    const courseId = parseCourseIdInput(courseInput);
    if (!courseId) { setCourseError("Enter a Garmin Connect course URL or numeric ID."); return; }
    setCourseBusy(true);
    setCourseError(null);
    try {
      // Resolve the course's own name via the route endpoint itself (it
      // returns `name` alongside the GPS points) so the race can show a
      // real course title rather than just the bare id.
      const res = await fetch(`/api/garmin/course-route/${courseId}`);
      const d = await res.json() as { name?: string | null; error?: string };
      if (!res.ok || d.error) throw new Error(d.error ?? "Course not found");
      const patchRes = await fetch(`/api/races/${race.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ garminCourseId: courseId, garminCourseName: d.name ?? `Course ${courseId}` }),
      });
      const patchD = await patchRes.json() as { race?: Race; error?: string };
      if (!patchRes.ok || patchD.error || !patchD.race) throw new Error(patchD.error ?? "Failed to link course");
      setRace(patchD.race);
      setCourseInput("");
    } catch (e) {
      setCourseError(e instanceof Error ? e.message : "Failed to link course");
    } finally {
      setCourseBusy(false);
    }
  }

  async function unlinkCourse() {
    if (!race) return;
    setRace(prev => prev && { ...prev, garminCourseId: null, garminCourseName: null });
    try {
      await fetch(`/api/races/${race.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ garminCourseId: null, garminCourseName: null }),
      });
    } catch { /* best-effort */ }
  }

  function loadPaceProLibrary() {
    if (paceProLibrary !== null) return;
    fetch("/api/settings/pace-pro-saved")
      .then(r => r.json())
      .then((d: { mixes?: SavedPaceProMixSummary[] }) => setPaceProLibrary(d.mixes ?? []))
      .catch(() => setPaceProLibrary([]));
  }

  function openPaceProPicker() {
    setLinkingPaceProMix(true);
    loadPaceProLibrary();
  }

  async function linkPaceProMix(mixId: string) {
    if (!race) return;
    setPaceProLinkBusy(true);
    try {
      const res = await fetch(`/api/races/${race.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paceProMixId: mixId }),
      });
      const d = await res.json() as { race?: Race; error?: string };
      if (!res.ok || d.error || !d.race) throw new Error(d.error ?? "Failed to link mix");
      setRace(d.race);
      setLinkingPaceProMix(false);
    } catch { /* picker stays open so the user can retry */ } finally {
      setPaceProLinkBusy(false);
    }
  }

  async function unlinkPaceProMix() {
    if (!race) return;
    setRace(prev => prev && { ...prev, paceProMixId: null });
    try {
      await fetch(`/api/races/${race.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paceProMixId: null }),
      });
    } catch { /* best-effort */ }
  }

  // Hands the linked Pace Pro mix's tracklist off to the Dashboard's own
  // Edit/Remix/Fill-the-gap flow — the exact same sessionStorage handoff
  // PaceProClient.tsx's "Send to dashboard" button already uses
  // (?loadPaceProMix=1); nothing new on the Dashboard side.
  async function sendToDashboard() {
    if (!race?.paceProMixId) return;
    setSendingToDashboard(true);
    setSendError(null);
    try {
      const res = await fetch(`/api/settings/pace-pro-saved?id=${encodeURIComponent(race.paceProMixId)}`);
      const d = await res.json() as { mix?: SavedPaceProMixSummary; error?: string };
      if (!res.ok || d.error || !d.mix) throw new Error(d.error ?? "Failed to load the linked mix");
      const mix = d.mix;
      const parsed = parsePaceProCsv(mix.splitsCsvText);
      const segments = parsed.ok ? paceProSplitsToSegments(parsed.splits) : [];
      const today = new Date().toISOString().slice(0, 10);
      const date = race.raceDate && race.raceDate <= today ? race.raceDate : today;
      sessionStorage.setItem("paceProDashboardHandoff", JSON.stringify({
        workoutTitle: race.name, date, totalSec: mix.totalSec, timeline: mix.timeline, segments,
        splitsCsvText: mix.splitsCsvText, fileName: mix.fileName, savedMixId: mix.id,
      }));
      window.location.href = "/dashboard?loadPaceProMix=1";
    } catch (e) {
      setSendError(e instanceof Error ? e.message : "Failed to send to dashboard");
      setSendingToDashboard(false);
    }
  }

  return (
    <div
      className="min-h-screen flex flex-col bg-cover bg-fixed bg-center bg-no-repeat bg-slate-950 text-slate-100"
      style={{ backgroundImage: "linear-gradient(rgba(2,6,23,0.75), rgba(2,6,23,0.75)), url('/dashboard-hero.png')" }}
    >
      <header className="border-b border-white/5 bg-slate-950/70 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-[100rem] mx-auto px-4 h-14 flex items-center justify-between">
          <Link href="/races" className="text-sm text-slate-500 hover:text-slate-300 transition-colors">
            ← Races
          </Link>
          <span className="font-bold text-green-400 text-lg tracking-tight">🏁 Race</span>
          <div />
        </div>
      </header>

      <div className="flex-1 max-w-[100rem] w-full mx-auto px-4 py-6 space-y-6">
        {loading && <p className="text-sm text-slate-500 text-center">Loading…</p>}
        {error && <div className="rounded-xl bg-red-950/50 border border-red-800/50 p-4 text-red-400 text-sm">{error}</div>}

        {race && (
          <>
            <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5 space-y-3">
              {editing ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-2">
                    <input
                      type="text"
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      autoFocus
                      className="flex-1 min-w-48 rounded-lg bg-slate-800/60 border border-white/10 text-sm px-3 py-1.5 text-slate-100 focus:outline-none focus:ring-1 focus:ring-green-500"
                    />
                    <input
                      type="date"
                      value={editDate}
                      onChange={e => setEditDate(e.target.value)}
                      className="rounded-lg bg-slate-800/60 border border-white/10 text-sm px-3 py-1.5 text-slate-100 focus:outline-none focus:ring-1 focus:ring-green-500"
                    />
                    <input
                      type="number"
                      step="0.1"
                      value={editDistance}
                      onChange={e => setEditDistance(e.target.value)}
                      placeholder="Distance (mi)"
                      className="w-32 rounded-lg bg-slate-800/60 border border-white/10 text-sm px-3 py-1.5 text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-green-500"
                    />
                  </div>
                  <input
                    type="text"
                    value={editNotes}
                    onChange={e => setEditNotes(e.target.value)}
                    placeholder="Notes (optional)"
                    className="w-full rounded-lg bg-slate-800/60 border border-white/10 text-sm px-3 py-1.5 text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-green-500"
                  />
                  {editError && <p className="text-xs text-red-400">{editError}</p>}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={saveEdit}
                      disabled={editBusy || !editName.trim()}
                      className="rounded-lg bg-green-500 hover:bg-green-400 disabled:opacity-40 text-black font-semibold text-xs px-3 py-1.5 transition-colors"
                    >
                      {editBusy ? "Saving…" : "Save"}
                    </button>
                    <button onClick={() => setEditing(false)} className="text-xs text-slate-500 hover:text-slate-300">Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h1 className="text-xl font-semibold text-slate-100">{race.name}</h1>
                    <p className="text-sm text-slate-500 mt-1">
                      {fmtDate(race.raceDate)}{race.distanceMi ? ` · ${race.distanceMi}mi` : ""}
                      {race.status === "completed" ? " · Completed" : " · Upcoming"}
                    </p>
                    {race.notes && <p className="text-sm text-slate-400 mt-1">{race.notes}</p>}
                  </div>
                  <button onClick={startEdit} className="shrink-0 text-xs text-slate-500 hover:text-slate-300">Edit</button>
                </div>
              )}
            </div>

            {/* Course / route — real GPS from a linked past activity takes
                priority (it's a genuine recorded run); a manually-linked
                Garmin Connect course is the fallback for a race that hasn't
                been run yet. */}
            <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5 space-y-3">
              <h2 className="font-semibold flex items-center gap-2"><span className="text-base">🗺️</span> Course</h2>

              {race.garminActivityId ? (
                <div className="flex items-center gap-3 flex-wrap text-sm">
                  <span className="text-sky-400">Linked to a past run</span>
                  <Link href={`/garmin/activity/${race.garminActivityId}`} className="text-xs text-sky-400 hover:text-sky-300 underline">
                    View activity →
                  </Link>
                  <button onClick={unlinkActivity} className="text-xs text-slate-500 hover:text-red-400">Unlink</button>
                </div>
              ) : linkingActivity ? (
                <div className="rounded-lg bg-slate-800/60 border border-white/10 p-2 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-slate-400">Link a past run for the course</p>
                    <button onClick={() => setLinkingActivity(false)} className="text-xs text-slate-500 hover:text-slate-300">✕</button>
                  </div>
                  <input
                    type="text"
                    value={activityFilter}
                    onChange={e => setActivityFilter(e.target.value)}
                    placeholder="Filter by name…"
                    autoFocus
                    className="w-full rounded-lg bg-slate-900/60 border border-white/10 text-xs px-2.5 py-1 text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-sky-500"
                  />
                  <div className="max-h-48 overflow-y-auto no-scrollbar space-y-1">
                    {activities === null && <p className="text-xs text-slate-600">Loading…</p>}
                    {activities !== null && activities
                      .filter(a => !activityFilter.trim() || (a.name ?? "").toLowerCase().includes(activityFilter.trim().toLowerCase()))
                      .slice(0, 30)
                      .map(a => (
                        <button
                          key={a.activity_id}
                          onClick={() => linkActivity(a.activity_id)}
                          disabled={linkBusy}
                          className="w-full text-left text-xs rounded-md bg-slate-900/60 hover:bg-slate-900 disabled:opacity-40 px-2 py-1 text-slate-300 transition-colors flex items-center justify-between gap-2"
                        >
                          <span className="truncate">{a.name || "Activity"}</span>
                          <span className="text-slate-600 shrink-0">{a.start_time.slice(0, 10)}{a.distance ? ` · ${a.distance.toFixed(1)}mi` : ""}</span>
                        </button>
                      ))}
                    {activities !== null && activities.length === 0 && (
                      <p className="text-xs text-slate-600">No running activities found.</p>
                    )}
                  </div>
                </div>
              ) : (
                <button onClick={openActivityPicker} className="text-xs text-sky-300/80 hover:text-sky-200 underline">
                  🔗 Link a past run for the course…
                </button>
              )}

              {!race.garminActivityId && (
                race.garminCourseId ? (
                  <div className="flex items-center gap-3 flex-wrap text-sm border-t border-white/5 pt-3">
                    <span className="text-purple-400">Linked course: {race.garminCourseName || race.garminCourseId}</span>
                    <a
                      href={`https://connect.garmin.com/app/course/${race.garminCourseId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-purple-400 hover:text-purple-300 underline"
                    >
                      View on Garmin Connect →
                    </a>
                    <button onClick={unlinkCourse} className="text-xs text-slate-500 hover:text-red-400">Unlink</button>
                  </div>
                ) : (
                  <div className="border-t border-white/5 pt-3 space-y-1.5">
                    <p className="text-xs text-slate-500">Or link a Garmin Connect course (a race you haven&apos;t run yet):</p>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={courseInput}
                        onChange={e => setCourseInput(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") linkCourse(); }}
                        placeholder="Course URL or ID, e.g. 25436796"
                        className="flex-1 min-w-0 rounded-lg bg-slate-800/60 border border-white/10 text-xs px-2.5 py-1.5 text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-purple-500"
                      />
                      <button
                        onClick={linkCourse}
                        disabled={courseBusy || !courseInput.trim()}
                        className="rounded-lg bg-purple-500/15 border border-purple-500/40 hover:bg-purple-500/25 disabled:opacity-40 text-purple-300 font-medium text-xs px-2.5 py-1.5 transition-colors shrink-0"
                      >
                        {courseBusy ? "Linking…" : "Link"}
                      </button>
                    </div>
                    {courseError && <p className="text-xs text-red-400">{courseError}</p>}
                  </div>
                )
              )}
            </div>

            {/* Pace Pro — pick from the existing library (build/upload it on
                the Pace Pro page as normal); not generated here. */}
            <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5 space-y-3">
              <h2 className="font-semibold flex items-center gap-2"><span className="text-base">🎧</span> Pace Pro plan</h2>

              {race.paceProMixId ? (
                <div className="flex items-center gap-3 flex-wrap text-sm">
                  <span className="text-purple-400">Linked</span>
                  <button
                    onClick={sendToDashboard}
                    disabled={sendingToDashboard}
                    className="rounded-lg bg-purple-500/15 border border-purple-500/40 hover:bg-purple-500/25 disabled:opacity-40 text-purple-300 font-medium text-xs px-2.5 py-1.5 transition-colors"
                  >
                    {sendingToDashboard ? "Loading…" : "Load tracklist → Dashboard"}
                  </button>
                  <button onClick={unlinkPaceProMix} className="text-xs text-slate-500 hover:text-red-400">Unlink</button>
                </div>
              ) : linkingPaceProMix ? (
                <div className="rounded-lg bg-slate-800/60 border border-white/10 p-2 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-slate-400">Link a saved Pace Pro mix</p>
                    <button onClick={() => setLinkingPaceProMix(false)} className="text-xs text-slate-500 hover:text-slate-300">✕</button>
                  </div>
                  <div className="max-h-48 overflow-y-auto no-scrollbar space-y-1">
                    {paceProLibrary === null && <p className="text-xs text-slate-600">Loading…</p>}
                    {paceProLibrary?.length === 0 && <p className="text-xs text-slate-600">No saved Pace Pro mixes yet.</p>}
                    {paceProLibrary?.map(m => (
                      <button
                        key={m.id}
                        onClick={() => linkPaceProMix(m.id)}
                        disabled={paceProLinkBusy}
                        className="w-full text-left text-xs rounded-md bg-slate-900/60 hover:bg-slate-900 disabled:opacity-40 px-2 py-1 text-slate-300 transition-colors truncate"
                      >
                        {m.title}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <button onClick={openPaceProPicker} className="text-xs text-purple-300/80 hover:text-purple-200 underline">
                  🔗 Link a Pace Pro mix…
                </button>
              )}
              {sendError && <p className="text-xs text-red-400">{sendError}</p>}
            </div>

            {(race.garminActivityId || race.garminCourseId) && (() => {
              const parsed = linkedMix ? parsePaceProCsv(linkedMix.splitsCsvText) : null;
              const workoutSegments = parsed?.ok ? paceProSplitsToSegments(parsed.splits) : undefined;
              const mixTracks: MapMixTrack[] | undefined = linkedMix
                ? linkedMix.timeline.flatMap(s => s.tracks).map(t => {
                    const [mm, ss] = t.startsAt.split(":").map(Number);
                    return { uri: t.uri, name: t.name, artist: t.artist, startsAtSec: (mm || 0) * 60 + (ss || 0), durationSec: t.durationSec, tempo: t.tempo };
                  })
                : undefined;
              return (
                <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 overflow-hidden">
                  <InlineRouteMap
                    activityId={race.garminActivityId ?? race.garminCourseId ?? ""}
                    courseId={!race.garminActivityId && race.garminCourseId ? race.garminCourseId : undefined}
                    label={race.name}
                    workoutSegments={workoutSegments}
                    mixTracks={mixTracks}
                  />
                </div>
              );
            })()}
          </>
        )}
      </div>
    </div>
  );
}
