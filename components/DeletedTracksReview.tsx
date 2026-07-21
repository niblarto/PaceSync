"use client";

import { useState } from "react";

export interface RejectedTrack {
  uri: string;
  name: string;
  artist: string;
  deletedAt: string;
}

// Review panel shown when an import contains tracks the user previously
// deleted from the library. Default action rejects them all; per-track
// checkboxes override individual tracks so they're imported again (and
// removed from the deletion log).
export function DeletedTracksReview({ tracks, onConfirm, busy = false }: {
  tracks: RejectedTrack[];
  /** allowUris = the overridden tracks to import anyway (empty = reject all) */
  onConfirm: (allowUris: string[]) => void;
  busy?: boolean;
}) {
  const [checked, setChecked] = useState<Set<string>>(new Set());

  const toggle = (uri: string) => {
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(uri)) next.delete(uri); else next.add(uri);
      return next;
    });
  };

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
      <p className="text-xs text-amber-400 font-medium">
        {tracks.length} track{tracks.length === 1 ? " was" : "s were"} previously deleted from the library — not re-imported by default. Tick any you want back.
      </p>
      <div className="max-h-48 overflow-y-auto space-y-1 pr-1">
        {tracks.map(t => (
          <label key={t.uri} className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer hover:bg-white/5 rounded px-1.5 py-1">
            <input
              type="checkbox"
              checked={checked.has(t.uri)}
              onChange={() => toggle(t.uri)}
              className="accent-amber-500 shrink-0"
            />
            <span className="truncate">
              {t.name}{t.artist ? <span className="text-slate-500"> — {t.artist}</span> : null}
            </span>
            <span className="ml-auto text-slate-600 shrink-0" title="Deleted on">
              {t.deletedAt.slice(0, 10)}
            </span>
          </label>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onConfirm(Array.from(checked))}
          disabled={busy}
          className="text-xs px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold transition-colors"
        >
          {checked.size > 0 ? `Continue — re-import ${checked.size}, reject ${tracks.length - checked.size}` : "Continue — reject all"}
        </button>
      </div>
    </div>
  );
}
