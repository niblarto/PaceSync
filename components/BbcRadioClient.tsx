"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { BbcPlaylistCard } from "./BbcPlaylistCard";

const BBC_DEFAULTS = [
  { pid: "m001j52w", name: "6 Music Playlist" },
  { pid: "m0012v02", name: "6 Music's Indie Forever" },
  { pid: "m002xsbn", name: "Lauren Laverne" },
];

export function BbcRadioClient() {
  const [programmes, setProgrammes] = useState<{ pid: string; name: string; synopsis?: string }[]>(BBC_DEFAULTS);

  useEffect(() => {
    fetch("/api/bbc/programmes")
      .then(r => r.json())
      .then((d: { programmes?: { pid: string; name: string }[] }) => {
        if (d.programmes?.length) setProgrammes(d.programmes);
      })
      .catch(() => {});
  }, []);

  function removeProgramme(pid: string) {
    const updated = programmes.filter(p => p.pid !== pid);
    setProgrammes(updated);
    fetch("/api/bbc/programmes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ programmes: updated }),
    }).catch(() => {});
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-white/5 bg-slate-950/70 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
          <Link href="/dashboard" className="text-sm text-slate-500 hover:text-slate-300 transition-colors">
            ← Dashboard
          </Link>
          <span className="font-bold text-green-400 text-lg tracking-tight">BBC Radio</span>
          <Link href="/settings" className="text-xs text-slate-500 hover:text-slate-300 transition-colors">
            Settings
          </Link>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6 items-start">
          {programmes.map(p => (
            <BbcPlaylistCard
              key={p.pid}
              pid={p.pid}
              defaultName={p.name}
              synopsis={p.synopsis}
              onRemove={() => removeProgramme(p.pid)}
              editHref={`/settings?bbc=replace&pid=${p.pid}&name=${encodeURIComponent(p.name)}`}
            />
          ))}
          <Link
            href="/settings?bbc=add"
            className="flex items-center justify-center gap-2 rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 border-dashed p-5 text-slate-500 hover:text-slate-300 hover:border-white/20 transition-colors min-h-[80px]"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
            </svg>
            <span className="text-sm font-medium">Add BBC Programme</span>
          </Link>
        </div>
      </main>
    </div>
  );
}
