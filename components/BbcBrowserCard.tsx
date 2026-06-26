"use client";

import { useState } from "react";
import type { ScheduleSlot } from "@/app/api/bbc/schedule/route";

const BBC_SERVICES = [
  { id: "p00fzl86", name: "Radio 1" },
  { id: "p00fzl64", name: "Radio 1Xtra" },
  { id: "p0hyc2r0", name: "Radio 1 Anthems" },
  { id: "p080kbtk", name: "Radio 1 Dance" },
  { id: "p00fzl8v", name: "Radio 2" },
  { id: "p00fzl8t", name: "Radio 3" },
  { id: "p0hyc31m", name: "Radio 3 Unwind" },
  { id: "p00fzl65", name: "Radio 6 Music" },
  { id: "p00fzl68", name: "Asian Network" },
];

interface Props {
  onAdd: (programme: { pid: string; name: string; synopsis?: string }) => void;
  defaultOpen?: boolean;
  saveLabel?: string;
}

interface UniqueProg {
  brand: string;      // display name (before " – ")
  pid: string;        // most recent episode PID
  synopsis: string;
  lastDate: string;
  lastTime: string;
}

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin inline-block" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function getBrand(title: string): string {
  if (title.includes(" – ")) return title.split(" – ")[0].trim();
  if (title.includes(" - ")) return title.split(" - ")[0].trim();
  return title;
}

function dedupeByBrand(slots: ScheduleSlot[]): UniqueProg[] {
  // For each brand, prefer the most recent PAST episode.
  // If a brand has no past episodes this week, fall back to the earliest upcoming.
  const now = new Date();

  const pastMap  = new Map<string, ScheduleSlot>(); // latest past slot per brand
  const futureMap = new Map<string, ScheduleSlot>(); // earliest future slot per brand

  for (const slot of slots) {
    const brand = getBrand(slot.title);
    const dt = slot.rawDate
      ? new Date(slot.rawDate + "T" + (slot.time || "00:00") + ":00")
      : null;
    const isPast = dt ? dt <= now : false;

    if (isPast) {
      const prev = pastMap.get(brand);
      if (!prev || (dt && new Date(prev.rawDate + "T" + prev.time) < dt)) {
        pastMap.set(brand, slot); // keep latest past
      }
    } else {
      if (!futureMap.has(brand)) {
        futureMap.set(brand, slot); // keep earliest future
      }
    }
  }

  // Merge: prefer past; fallback to future
  const brands = new Set<string>([...Array.from(pastMap.keys()), ...Array.from(futureMap.keys())]);
  return Array.from(brands).map(brand => {
    const slot = pastMap.get(brand) ?? futureMap.get(brand)!;
    return { brand, pid: slot.pid, synopsis: slot.synopsis, lastDate: slot.date, lastTime: slot.time };
  });
}

export function BbcBrowserCard({ onAdd, defaultOpen = false, saveLabel = "Add to BBC Sources" }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const [selectedService, setSelectedService] = useState<{ id: string; name: string } | null>(null);
  const [schedule, setSchedule] = useState<ScheduleSlot[]>([]);
  const [loadingSchedule, setLoadingSchedule] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [selectedProg, setSelectedProg] = useState<UniqueProg | null>(null);
  const [addedBrands, setAddedBrands] = useState<Set<string>>(new Set());

  async function loadSchedule(service: { id: string; name: string }) {
    setSelectedService(service);
    setSelectedProg(null);
    setSchedule([]);
    setScheduleError(null);
    setLoadingSchedule(true);
    try {
      const res = await fetch(`/api/bbc/schedule?service=${service.id}`);
      const data = await res.json() as { items?: ScheduleSlot[]; error?: string };
      if (data.error) throw new Error(data.error);
      setSchedule(data.items ?? []);
      if ((data.items ?? []).length === 0) setScheduleError("No programmes found in schedule");
    } catch (e) {
      setScheduleError(e instanceof Error ? e.message : "Failed to load schedule");
    } finally {
      setLoadingSchedule(false);
    }
  }

  function handleAdd() {
    if (!selectedProg) return;
    onAdd({ pid: selectedProg.pid, name: selectedProg.brand, synopsis: selectedProg.synopsis });
    setAddedBrands(prev => { const s = new Set(Array.from(prev)); s.add(selectedProg.brand); return s; });
    setSelectedProg(null);
  }

  const programmes = dedupeByBrand(schedule);

  return (
    <div className="rounded-xl bg-slate-900 border border-slate-800">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-5 py-4 text-left"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold rounded px-1.5 py-0.5 bg-[#FF4200] text-white">BBC</span>
          <span className="font-semibold">Browse BBC Radio</span>
        </div>
        <span className="text-slate-500 text-xs">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="border-t border-slate-800 px-5 pb-5 space-y-4">

          {/* Station grid */}
          <div>
            <p className="text-xs text-slate-500 mt-4 mb-3">Select a station to see this week&apos;s programmes</p>
            <div className="grid grid-cols-3 gap-1.5">
              {BBC_SERVICES.map(s => (
                <button
                  key={s.id}
                  onClick={() => loadSchedule(s)}
                  className={`rounded-lg border px-2.5 py-2 text-xs font-medium transition-colors text-left ${
                    selectedService?.id === s.id
                      ? "bg-[#FF4200]/20 border-[#FF4200]/50 text-white"
                      : "bg-slate-800 border-slate-700 text-slate-300 hover:border-slate-500"
                  }`}
                >
                  {s.name}
                </button>
              ))}
            </div>
          </div>

          {/* Loading / error */}
          {loadingSchedule && (
            <p className="text-sm text-slate-400 flex items-center gap-2"><Spinner /> Loading…</p>
          )}
          {scheduleError && (
            <p className="text-sm text-red-400">{scheduleError}</p>
          )}

          {/* Programme list (deduplicated) */}
          {programmes.length > 0 && (
            <div className="max-h-[420px] overflow-y-auto no-scrollbar space-y-0.5 pr-1">
              {programmes.map(prog => {
                const isSelected = selectedProg?.brand === prog.brand;
                const wasAdded = addedBrands.has(prog.brand);
                return (
                  <button
                    key={prog.brand}
                    onClick={() => setSelectedProg(p => p?.brand === prog.brand ? null : prog)}
                    className={`w-full text-left rounded-lg px-3 py-2.5 transition-colors border ${
                      isSelected
                        ? "bg-green-500/10 border-green-500/30"
                        : "hover:bg-slate-800 border-transparent"
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <p className={`text-sm font-medium truncate ${isSelected ? "text-green-400" : "text-slate-200"}`}>
                          {prog.brand}
                        </p>
                        {prog.synopsis && (
                          <p className="text-xs text-slate-500 truncate mt-0.5">{prog.synopsis}</p>
                        )}
                        <p className="text-xs text-slate-600 mt-0.5">
                          Last on: {prog.lastDate}{prog.lastTime ? ` · ${prog.lastTime}` : ""}
                        </p>
                      </div>
                      {wasAdded && !isSelected && (
                        <span className="text-xs text-green-600 shrink-0 pt-0.5">✓</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {/* Save bar */}
          {selectedProg && (
            <div className="rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-200 truncate">{selectedProg.brand}</p>
                <a
                  href={`https://www.bbc.co.uk/programmes/${selectedProg.pid}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={e => e.stopPropagation()}
                  className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300 font-mono transition-colors"
                >
                  Open programme
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                </a>
              </div>
              <button
                onClick={handleAdd}
                className="shrink-0 rounded-lg bg-green-500 hover:bg-green-400 text-black font-semibold text-xs px-4 py-2 transition-colors whitespace-nowrap"
              >
                {saveLabel}
              </button>
            </div>
          )}

        </div>
      )}
    </div>
  );
}
