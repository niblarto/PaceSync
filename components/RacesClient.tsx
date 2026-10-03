"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

// Dashboard -> Races page. See lib/races.ts's own doc comment for why this
// is a durable, user-managed table rather than a live re-derivation of
// Runna's schedule + GarminDB the way components/RunnaCard.tsx already
// does (and keeps needing bug fixes for).
// Stage 1: list + add/edit/delete upcoming and completed races.
// Stage 2: link a past Garmin activity as the course source; suggestions
// pulled from the live Runna feed.
// Each race's own title links to /races/[id] (components/RaceDetailClient.tsx)
// — the course/route display, course-URL linking, and Pace Pro linking all
// live THERE now, not on this list page, per explicit request.

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
  createdAt: string;
  updatedAt: string;
}

function fmtDate(d: string | null): string {
  if (!d) return "No date set";
  return new Date(`${d}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

// A row from /api/garmin/data's `activities` array — that route returns
// the whole Garmin dataset (daily/sleep/weekly too, already cached
// in-process by lib/garmin-cache.ts), so this only picks the fields the
// "link a past run for the course" picker actually needs.
interface GarminActivitySummary {
  activity_id: string | number;
  name: string | null;
  sport: string | null;
  sub_sport: string | null;
  start_time: string;
  distance: number | null;
}

// A candidate race pulled live from the Runna schedule feed or GarminDB's
// own race-titled activities, shown as a dismissible suggestion rather
// than auto-added — see the "Suggestions" section's own comment for why.
interface RaceSuggestion {
  key: string; // stable id for dismissal, independent of anything persisted
  name: string;
  raceDate: string | null;
  status: RaceStatus;
  runnaUid?: string;
  garminActivityId?: string;
  distanceMi?: number | null;
}

export function RacesClient() {
  const [races, setRaces] = useState<Race[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState("");
  const [addDate, setAddDate] = useState("");
  const [addDistance, setAddDistance] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDate, setEditDate] = useState("");
  const [editDistance, setEditDistance] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // "Link a past run for the course" — which upcoming race's picker is
  // open, its search text, and the running-only activity list (lazily
  // loaded from /api/garmin/data the first time any picker opens).
  const [linkingRaceId, setLinkingRaceId] = useState<string | null>(null);
  const [linkFilter, setLinkFilter] = useState("");
  const [activities, setActivities] = useState<GarminActivitySummary[] | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);

  // Runna suggestions — races Runna's own live feed knows about (either
  // still upcoming, or completed but still within its 8-day lookback) that
  // aren't in the races table yet. Shown as dismissible cards rather than
  // auto-added: Runna's own "race" classification is UID-substring-based
  // (lib/runna-schedule.ts's classifyType) and can mis-tag, and a race the
  // user already tracks manually shouldn't reappear here just because
  // Runna also happens to know about it under a slightly different title.
  // Dismissals are per-session only (a plain Set, not persisted) — a race
  // dismissed today that's still not in the table tomorrow is worth
  // surfacing again, since it means it's genuinely still untracked.
  const [suggestions, setSuggestions] = useState<RaceSuggestion[] | null>(null);
  const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<string>>(new Set());
  const [addingSuggestion, setAddingSuggestion] = useState<string | null>(null);

  function load() {
    fetch("/api/races")
      .then(r => r.json())
      .then((d: { races?: Race[]; error?: string }) => {
        if (d.error) { setError(d.error); return; }
        setRaces(d.races ?? []);
      })
      .catch(e => setError(String(e)));
  }

  function loadSuggestions() {
    fetch("/api/runna/workouts")
      .then(r => r.json())
      .then((d: { workouts?: { uid: string; date: string; title: string; type: string; distanceMi: number | null }[]; pastRuns?: { uid: string; date: string; title: string; type: string; distanceMi: number | null }[]; error?: string }) => {
        if (d.error) return;
        const raw: RaceSuggestion[] = [
          ...(d.workouts ?? []).filter(w => w.type === "race").map(w => ({
            key: w.uid, name: w.title, raceDate: w.date, status: "upcoming" as const, runnaUid: w.uid, distanceMi: w.distanceMi,
          })),
          ...(d.pastRuns ?? []).filter(r => r.type === "race").map(r => ({
            key: r.uid, name: r.title, raceDate: r.date, status: "completed" as const, runnaUid: r.uid, distanceMi: r.distanceMi,
          })),
        ];
        setSuggestions(raw);
      })
      .catch(() => {});
  }

  useEffect(() => { load(); loadSuggestions(); }, []);

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

  function openLinkPicker(raceId: string) {
    setLinkingRaceId(raceId);
    setLinkFilter("");
    loadActivities();
  }

  async function linkActivity(raceId: string, activityId: string | number) {
    setLinkBusy(true);
    try {
      const res = await fetch(`/api/races/${raceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ garminActivityId: String(activityId) }),
      });
      const d = await res.json() as { race?: Race; error?: string };
      if (!res.ok || d.error || !d.race) throw new Error(d.error ?? "Failed to link activity");
      setRaces(prev => (prev ?? []).map(r => r.id === raceId ? d.race! : r));
      setLinkingRaceId(null);
    } catch { /* picker stays open so the user can retry */ } finally {
      setLinkBusy(false);
    }
  }

  async function unlinkActivity(raceId: string) {
    setRaces(prev => (prev ?? []).map(r => r.id === raceId ? { ...r, garminActivityId: null } : r));
    try {
      await fetch(`/api/races/${raceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ garminActivityId: null }),
      });
    } catch { /* best-effort */ }
  }

  // Suggestions already covered by a real races row — matched by runnaUid
  // first (exact), falling back to a loose name+date match for a race
  // added manually before this suggestion strip existed (or added from a
  // DIFFERENT suggestion source later, e.g. a future Garmin-name heuristic).
  const visibleSuggestions = (suggestions ?? []).filter(s => {
    if (dismissedSuggestions.has(s.key)) return false;
    return !(races ?? []).some(r =>
      (r.runnaUid && r.runnaUid === s.runnaUid) ||
      (r.name.trim().toLowerCase() === s.name.trim().toLowerCase() && r.raceDate === s.raceDate)
    );
  });

  async function addSuggestion(s: RaceSuggestion) {
    setAddingSuggestion(s.key);
    try {
      const res = await fetch("/api/races", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: s.name, raceDate: s.raceDate, status: s.status, runnaUid: s.runnaUid, distanceMi: s.distanceMi ?? null,
        }),
      });
      const d = await res.json() as { race?: Race; error?: string };
      if (!res.ok || d.error || !d.race) throw new Error(d.error ?? "Failed to add");
      setRaces(prev => [d.race!, ...(prev ?? [])]);
      setDismissedSuggestions(prev => new Set(prev).add(s.key));
    } catch { /* leave the suggestion visible so the user can retry */ } finally {
      setAddingSuggestion(null);
    }
  }

  function dismissSuggestion(key: string) {
    setDismissedSuggestions(prev => new Set(prev).add(key));
  }

  async function addRace() {
    if (!addName.trim()) return;
    setAddBusy(true);
    setAddError(null);
    try {
      const res = await fetch("/api/races", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: addName.trim(),
          raceDate: addDate || null,
          status: "upcoming",
          distanceMi: addDistance ? parseFloat(addDistance) : null,
        }),
      });
      const d = await res.json() as { race?: Race; error?: string };
      if (!res.ok || d.error || !d.race) throw new Error(d.error ?? "Failed to add race");
      setRaces(prev => [d.race!, ...(prev ?? [])]);
      setAddOpen(false);
      setAddName(""); setAddDate(""); setAddDistance("");
    } catch (e) {
      setAddError(e instanceof Error ? e.message : "Failed to add race");
    } finally {
      setAddBusy(false);
    }
  }

  function startEdit(r: Race) {
    setEditingId(r.id);
    setEditName(r.name);
    setEditDate(r.raceDate ?? "");
    setEditDistance(r.distanceMi != null ? String(r.distanceMi) : "");
    setEditNotes(r.notes ?? "");
    setEditError(null);
  }

  async function saveEdit(id: string) {
    if (!editName.trim()) return;
    setEditBusy(true);
    setEditError(null);
    try {
      const res = await fetch(`/api/races/${id}`, {
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
      setRaces(prev => (prev ?? []).map(r => r.id === id ? d.race! : r));
      setEditingId(null);
    } catch (e) {
      setEditError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setEditBusy(false);
    }
  }

  async function markCompleted(id: string) {
    setRaces(prev => (prev ?? []).map(r => r.id === id ? { ...r, status: "completed" as const } : r));
    try {
      await fetch(`/api/races/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "completed" }),
      });
    } catch { /* best-effort — list will self-correct on next load if this failed */ }
  }

  async function deleteRace(id: string) {
    setRaces(prev => (prev ?? []).filter(r => r.id !== id));
    try {
      await fetch(`/api/races/${id}`, { method: "DELETE" });
    } catch { /* best-effort */ }
  }

  const upcoming = (races ?? []).filter(r => r.status === "upcoming");
  const completed = (races ?? []).filter(r => r.status === "completed");

  return (
    <div
      className="min-h-screen flex flex-col bg-cover bg-fixed bg-center bg-no-repeat bg-slate-950 text-slate-100"
      style={{ backgroundImage: "linear-gradient(rgba(2,6,23,0.75), rgba(2,6,23,0.75)), url('/dashboard-hero.png')" }}
    >
      <header className="border-b border-white/5 bg-slate-950/70 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-[100rem] mx-auto px-4 h-14 flex items-center justify-between">
          <Link href="/dashboard" className="text-sm text-slate-500 hover:text-slate-300 transition-colors">
            ← Dashboard
          </Link>
          <span className="font-bold text-green-400 text-lg tracking-tight">🏁 Races</span>
          <div />
        </div>
      </header>

      <div className="flex-1 max-w-[100rem] w-full mx-auto px-4 py-6 space-y-6">
        {error && <div className="rounded-xl bg-red-950/50 border border-red-800/50 p-4 text-red-400 text-sm">{error}</div>}

        {visibleSuggestions.length > 0 && (
          <div className="rounded-xl bg-amber-500/10 border border-amber-500/30 overflow-hidden">
            <div className="px-5 py-3 border-b border-amber-500/20">
              <h2 className="font-semibold text-amber-300 text-sm flex items-center gap-2">💡 Suggested from Runna</h2>
              <p className="text-xs text-amber-300/70 mt-0.5">Runna's own schedule knows about these — add them here to keep tracking them once they scroll out of its feed.</p>
            </div>
            <div className="divide-y divide-amber-500/10">
              {visibleSuggestions.map(s => (
                <div key={s.key} className="px-5 py-2.5 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm text-slate-200 truncate">{s.name}</p>
                    <p className="text-xs text-slate-500">{fmtDate(s.raceDate)}{s.status === "completed" ? " · completed" : ""}</p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 text-xs">
                    <button
                      onClick={() => addSuggestion(s)}
                      disabled={addingSuggestion === s.key}
                      className="rounded-lg bg-amber-500/20 hover:bg-amber-500/30 disabled:opacity-40 text-amber-300 font-medium px-2.5 py-1 transition-colors"
                    >
                      {addingSuggestion === s.key ? "Adding…" : "Add"}
                    </button>
                    <button onClick={() => dismissSuggestion(s.key)} className="text-slate-500 hover:text-slate-300">Dismiss</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 overflow-hidden">
          <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold flex items-center gap-2"><span className="text-base">📅</span> Upcoming races</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Races not yet in the Runna schedule, or booked further out than it shows.
              </p>
            </div>
            <button
              onClick={() => setAddOpen(o => !o)}
              className="shrink-0 rounded-lg bg-green-500 hover:bg-green-400 text-black font-semibold text-xs px-3 py-1.5 transition-colors"
            >
              {addOpen ? "Cancel" : "+ Add race"}
            </button>
          </div>

          {addOpen && (
            <div className="px-5 py-4 border-b border-white/10 bg-slate-800/30 space-y-2">
              <div className="flex flex-wrap gap-2">
                <input
                  type="text"
                  value={addName}
                  onChange={e => setAddName(e.target.value)}
                  placeholder="Race name"
                  autoFocus
                  className="flex-1 min-w-48 rounded-lg bg-slate-800/60 border border-white/10 text-sm px-3 py-1.5 text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-green-500"
                />
                <input
                  type="date"
                  value={addDate}
                  onChange={e => setAddDate(e.target.value)}
                  className="rounded-lg bg-slate-800/60 border border-white/10 text-sm px-3 py-1.5 text-slate-100 focus:outline-none focus:ring-1 focus:ring-green-500"
                />
                <input
                  type="number"
                  step="0.1"
                  value={addDistance}
                  onChange={e => setAddDistance(e.target.value)}
                  placeholder="Distance (mi)"
                  className="w-32 rounded-lg bg-slate-800/60 border border-white/10 text-sm px-3 py-1.5 text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-green-500"
                />
              </div>
              {addError && <p className="text-xs text-red-400">{addError}</p>}
              <button
                onClick={addRace}
                disabled={addBusy || !addName.trim()}
                className="rounded-lg bg-green-500 hover:bg-green-400 disabled:opacity-40 text-black font-semibold text-xs px-3 py-1.5 transition-colors"
              >
                {addBusy ? "Adding…" : "Add race"}
              </button>
            </div>
          )}

          <div className="divide-y divide-white/5">
            {races === null && <p className="text-sm text-slate-500 p-5 text-center">Loading…</p>}
            {races !== null && upcoming.length === 0 && (
              <p className="text-sm text-slate-500 p-5 text-center">No upcoming races yet.</p>
            )}
            {upcoming.map(r => (
              <div key={r.id} className="px-5 py-3">
                {editingId === r.id ? (
                  <div className="space-y-2">
                    <div className="flex flex-wrap gap-2">
                      <input
                        type="text"
                        value={editName}
                        onChange={e => setEditName(e.target.value)}
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
                        onClick={() => saveEdit(r.id)}
                        disabled={editBusy || !editName.trim()}
                        className="rounded-lg bg-green-500 hover:bg-green-400 disabled:opacity-40 text-black font-semibold text-xs px-3 py-1.5 transition-colors"
                      >
                        {editBusy ? "Saving…" : "Save"}
                      </button>
                      <button onClick={() => setEditingId(null)} className="text-xs text-slate-500 hover:text-slate-300">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <Link href={`/races/${r.id}`} className="text-sm font-medium text-slate-200 hover:text-green-300 truncate block transition-colors">
                          {r.name}
                        </Link>
                        <p className="text-xs text-slate-500">
                          {fmtDate(r.raceDate)}{r.distanceMi ? ` · ${r.distanceMi.toFixed(2)}mi` : ""}
                          {r.notes ? ` · ${r.notes}` : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-3 shrink-0 text-xs">
                        <button onClick={() => markCompleted(r.id)} className="text-emerald-400/80 hover:text-emerald-300">Mark completed</button>
                        <button onClick={() => startEdit(r)} className="text-slate-500 hover:text-slate-300">Edit</button>
                        <button onClick={() => deleteRace(r.id)} className="text-slate-500 hover:text-red-400">Delete</button>
                      </div>
                    </div>

                    {/* Course source — a past run whose route/GPS track this
                        upcoming race can reuse (route map, Pace Pro seed
                        distance). Distinct from a COMPLETED race's own
                        garmin_activity_id (that one IS the race itself, this
                        one is borrowed as a course reference). */}
                    {r.garminActivityId ? (
                      <div className="flex items-center gap-3 text-xs">
                        <span className="text-sky-400">🗺️ Course linked</span>
                        <Link href={`/garmin/activity/${r.garminActivityId}`} className="text-sky-400 hover:text-sky-300 underline">
                          View activity →
                        </Link>
                        <button onClick={() => unlinkActivity(r.id)} className="text-slate-500 hover:text-red-400">Unlink</button>
                      </div>
                    ) : linkingRaceId === r.id ? (
                      <div className="rounded-lg bg-slate-800/60 border border-white/10 p-2 space-y-1.5">
                        <div className="flex items-center justify-between">
                          <p className="text-[11px] text-slate-400">Link a past run for the course</p>
                          <button onClick={() => setLinkingRaceId(null)} className="text-[11px] text-slate-500 hover:text-slate-300">✕</button>
                        </div>
                        <input
                          type="text"
                          value={linkFilter}
                          onChange={e => setLinkFilter(e.target.value)}
                          placeholder="Filter by name…"
                          autoFocus
                          className="w-full rounded-lg bg-slate-900/60 border border-white/10 text-xs px-2.5 py-1 text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-sky-500"
                        />
                        <div className="max-h-40 overflow-y-auto no-scrollbar space-y-1">
                          {activities === null && <p className="text-[11px] text-slate-600">Loading…</p>}
                          {activities !== null && activities
                            .filter(a => !linkFilter.trim() || (a.name ?? "").toLowerCase().includes(linkFilter.trim().toLowerCase()))
                            .slice(0, 30)
                            .map(a => (
                              <button
                                key={a.activity_id}
                                onClick={() => linkActivity(r.id, a.activity_id)}
                                disabled={linkBusy}
                                className="w-full text-left text-[11px] rounded-md bg-slate-900/60 hover:bg-slate-900 disabled:opacity-40 px-2 py-1 text-slate-300 transition-colors flex items-center justify-between gap-2"
                              >
                                <span className="truncate">{a.name || "Activity"}</span>
                                <span className="text-slate-600 shrink-0">{a.start_time.slice(0, 10)}{a.distance ? ` · ${a.distance.toFixed(1)}mi` : ""}</span>
                              </button>
                            ))}
                          {activities !== null && activities.length === 0 && (
                            <p className="text-[11px] text-slate-600">No running activities found.</p>
                          )}
                        </div>
                      </div>
                    ) : (
                      <button onClick={() => openLinkPicker(r.id)} className="text-[11px] text-sky-300/80 hover:text-sky-200 underline">
                        🔗 Link a past run for the course…
                      </button>
                    )}
                    <Link href={`/races/${r.id}`} className="text-[11px] text-slate-500 hover:text-slate-300 underline block">
                      Open race page →
                    </Link>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 overflow-hidden">
          <div className="px-5 py-4 border-b border-white/10">
            <h2 className="font-semibold flex items-center gap-2"><span className="text-base">✅</span> Completed races</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Flagged from the Garmin activity page, or moved here once run.
            </p>
          </div>
          <div className="divide-y divide-white/5">
            {races !== null && completed.length === 0 && (
              <p className="text-sm text-slate-500 p-5 text-center">No completed races yet.</p>
            )}
            {completed.map(r => (
              <div key={r.id} className="px-5 py-3 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <Link href={`/races/${r.id}`} className="text-sm font-medium text-slate-200 hover:text-green-300 truncate block transition-colors">
                      {r.name}
                    </Link>
                    <p className="text-xs text-slate-500">
                      {fmtDate(r.raceDate)}{r.distanceMi ? ` · ${r.distanceMi.toFixed(2)}mi` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 text-xs">
                    {r.garminActivityId && (
                      <Link href={`/garmin/activity/${r.garminActivityId}`} className="text-sky-400 hover:text-sky-300 underline">
                        View activity →
                      </Link>
                    )}
                    <button onClick={() => deleteRace(r.id)} className="text-slate-500 hover:text-red-400">Delete</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
