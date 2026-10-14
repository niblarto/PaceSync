"use client";

import { useState } from "react";
import Link from "next/link";
import { useBrokenTracklists } from "./useBrokenTracklists";

// Warns when an upcoming schedule or Pace Pro tracklist still contains a
// track that's been deleted from the library, with a link straight to each
// one so the highlighted track can be Quick Swapped. Disappears by itself
// once every listed tracklist is repaired.

function fmtDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

export function BrokenTracklistsBanner() {
  const { broken } = useBrokenTracklists();
  const [collapsed, setCollapsed] = useState(false);
  if (broken.length === 0) return null;

  return (
    <div className="sticky top-14 z-30 bg-rose-500/15 border-b border-rose-500/40 text-rose-200 text-xs px-4 py-2">
      <div className="flex items-center justify-center gap-3">
        <span className="font-medium">
          ⚠ {broken.length} tracklist{broken.length === 1 ? "" : "s"} contain{broken.length === 1 ? "s" : ""} a deleted track — Quick Swap the highlighted track to repair
        </span>
        <button onClick={() => setCollapsed(c => !c)} className="text-rose-300/80 hover:text-rose-100 underline">
          {collapsed ? "Show" : "Hide"}
        </button>
      </div>
      {!collapsed && (
        <ul className="mt-1.5 space-y-1 max-w-3xl mx-auto">
          {broken.map(b => (
            <li key={b.key} className="flex flex-wrap items-baseline gap-x-2">
              <Link href={b.link} className="underline font-semibold text-rose-100 hover:text-white">
                {b.kind === "schedule" ? `${b.date ? fmtDate(b.date) : ""} · ${b.title}` : `Pace Pro · ${b.title}`}
              </Link>
              <span className="text-rose-300/80 min-w-0 truncate">
                {b.missing.map(m => `${m.name} — ${m.artist}`).join("; ")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
