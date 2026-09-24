"use client";

import { useRef, useState } from "react";

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

interface ParsedImportRow {
  index: number;
  title: string;
  artist: string;
  bpm: number | null;
  genre: string | null;
  libraryMatches: { uri: string; name: string; artist: string }[];
  previouslyDeleted: { name: string; artist: string; deletedAt: string } | null;
}

// Settings > Playlist Management's "Volumo Scrape" bulk import — for a bare
// tracklist CSV (title/artist/bpm/genre columns, as scraped from Volumo,
// e.g. copied from a forum or another DJ's set list) rather than a Spotify
// Exportify export. Three steps:
//
//   1. Upload CSV -> POST /api/tracks/import-lookup-csv/dedup, which checks
//      every row against the ACTIVE LIBRARY (loose name+artist match, so
//      "Song (Radio Edit)" still flags against an existing "Song") and the
//      deleted-tracks log, without writing or looking up anything online
//      yet.
//   2. Review screen: every row shown, checked by default. A row flagged
//      against the library shows which existing track(s) it matched
//      (several pasted rows can point at the same library track — this is
//      NOT a forced "keep one" choice, since near-variants may genuinely
//      need to stay as separate tracks); previously-deleted matches are
//      called out distinctly. The user picks exactly which checked rows to
//      import.
//   3. Confirm -> POST /api/tracks/import-lookup-csv/confirm (SSE): writes
//      the checked rows as pending library tracks using the CSV's own
//      supplied BPM/genre, then resolves a real Spotify URI via Deezer ->
//      ISRC -> ReccoBeats first (no Spotify calls, and ReccoBeats' tempo
//      OVERRIDES the pasted BPM wherever it resolves), falling back to a
//      throttled Spotify Search (secondary app first, same throttle as the
//      existing CSV-heal sweep's own URI phase) only for whatever's left.
export function ImportLookupCsvPanel() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [dedupLoading, setDedupLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<ParsedImportRow[] | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());

  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [result, setResult] = useState<{ added: number; resolvedOnline: number; spotifyResolved: number; stillUnresolved: number } | null>(null);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setFileName(file.name);
    setDedupLoading(true);
    setError(null);
    setRows(null);
    setResult(null);
    try {
      const csv = await file.text();
      const res = await fetch("/api/tracks/import-lookup-csv/dedup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv }),
      });
      const data = await res.json() as { rows?: ParsedImportRow[]; error?: string };
      if (!res.ok || data.error || !data.rows) throw new Error(data.error ?? `Failed to parse CSV (${res.status})`);
      setRows(data.rows);
      // Every row checked by default EXCEPT ones already on the
      // deleted-tracks log, or ones that already match something in the
      // active library — both default unchecked, so a track the user
      // deliberately deleted before, or already has, doesn't silently get
      // re-added/duplicated just because it happened to reappear in a
      // fresh scrape. Everything else stays checked so nothing else is
      // silently dropped; the review screen is for opting individual rows
      // OUT, not opting every row back in.
      setChecked(new Set(data.rows.filter(r => !r.previouslyDeleted && r.libraryMatches.length === 0).map(r => r.index)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to read CSV");
    } finally {
      setDedupLoading(false);
    }
  }

  function toggle(index: number) {
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index); else next.add(index);
      return next;
    });
  }

  async function confirmImport() {
    if (!rows) return;
    const picked = rows.filter(r => checked.has(r.index));
    if (picked.length === 0) { setError("Check at least one track to import."); return; }
    setImporting(true);
    setError(null);
    setLog([]);
    setProgress(null);
    try {
      const res = await fetch("/api/tracks/import-lookup-csv/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: picked.map(r => ({ title: r.title, artist: r.artist, bpm: r.bpm, genre: r.genre })) }),
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? `Import failed (${res.status})`);
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
            { type: string; phase?: string; current?: number; total?: number; resolved?: number; text?: string; error?: string;
              added?: number; resolvedOnline?: number; spotifyResolved?: number; stillUnresolved?: number };
          if (msg.type === "phase") {
            const label = msg.phase === "writing" ? "Writing tracks to library"
              : msg.phase === "deezer" ? "Resolving via Deezer/ReccoBeats"
              : "Searching Spotify (throttled)";
            setProgress(`${label}… ${msg.current}/${msg.total}${msg.resolved != null ? ` (${msg.resolved} resolved)` : ""}`);
          } else if (msg.type === "log" && msg.text) {
            setLog(prev => [...prev, msg.text!]);
          } else if (msg.type === "error") {
            throw new Error(msg.error ?? "Import failed");
          } else if (msg.type === "done") {
            setResult({ added: msg.added ?? 0, resolvedOnline: msg.resolvedOnline ?? 0, spotifyResolved: msg.spotifyResolved ?? 0, stillUnresolved: msg.stillUnresolved ?? 0 });
            setRows(null);
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setProgress(null);
      setImporting(false);
    }
  }

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-slate-300">Volumo Scrape</label>
      <p className="text-xs text-slate-500">
        Upload a plain tracklist CSV — not a Spotify export — with title, artist, bpm and genre columns
        (e.g. a set list copied from elsewhere). Checked against the library first so near-duplicates
        aren&apos;t silently re-added; the online lookup for a fresh Spotify URI runs only after you confirm.
      </p>

      <div className="flex items-center gap-3 flex-wrap">
        <input ref={fileRef} type="file" accept=".csv" onChange={handleFile} className="hidden" />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={dedupLoading || importing}
          className="inline-flex items-center gap-2 rounded-lg bg-slate-700/80 hover:bg-slate-600/80 disabled:opacity-40 text-slate-200 text-sm font-medium px-4 py-2 transition-colors"
        >
          {dedupLoading ? <><Spinner />Checking…</> : "Browse CSV"}
        </button>
        {fileName && <span className="text-xs text-slate-500">{fileName}</span>}
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {rows && (
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <button
              onClick={confirmImport}
              disabled={importing || checked.size === 0}
              className="inline-flex items-center gap-2 rounded-lg bg-green-500 hover:bg-green-400 disabled:opacity-40 text-black font-semibold text-xs px-4 py-1.5 transition-colors"
            >
              {importing ? <><Spinner />Importing…</> : `Import ${checked.size} track${checked.size === 1 ? "" : "s"}`}
            </button>
            <span className="text-xs text-slate-600">{rows.length} parsed, {checked.size} checked</span>
          </div>

          {/* Progress/log shown right under the button (not after the
              214-row review list below) — with a long list, the SAME
              progress text sitting below it was scrolled out of view,
              which is exactly why a real, working import looked like
              nothing was happening (confirmed: the request was genuinely
              progressing server-side the whole time). */}
          {importing && (
            <div className="space-y-2">
              {progress && (
                <p className="text-xs text-purple-300 flex items-center gap-1.5"><Spinner /> {progress}</p>
              )}
              {log.length > 0 && (
                <div className="rounded-lg bg-slate-950/60 border border-white/10 p-3 space-y-1 font-mono text-xs max-h-32 overflow-y-auto no-scrollbar">
                  {log.map((l, i) => <p key={i} className="text-slate-500">{l}</p>)}
                </div>
              )}
            </div>
          )}

          <div className="rounded-lg border border-white/10 divide-y divide-white/5 max-h-96 overflow-y-auto no-scrollbar">
            {rows.map(r => {
              const flagged = r.libraryMatches.length > 0 || !!r.previouslyDeleted;
              return (
                <div key={r.index} className={`px-3 py-2 flex items-start gap-3 ${flagged ? "bg-amber-500/5" : ""}`}>
                  <input
                    type="checkbox"
                    checked={checked.has(r.index)}
                    onChange={() => toggle(r.index)}
                    className="accent-emerald-500 mt-1 shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-slate-200 truncate">
                      {r.title} <span className="text-slate-500">— {r.artist}</span>
                    </p>
                    <p className="text-xs text-slate-500 flex items-center gap-2 flex-wrap">
                      {r.bpm != null && <span className="text-green-400">{r.bpm} BPM</span>}
                      {r.genre && <span className="text-slate-600">· {r.genre}</span>}
                    </p>
                    {r.previouslyDeleted && (
                      <p className="text-xs text-red-400 mt-0.5">
                        ⚠ Previously deleted: &quot;{r.previouslyDeleted.name}&quot; — {r.previouslyDeleted.artist}
                        {" "}({new Date(r.previouslyDeleted.deletedAt).toLocaleDateString()})
                      </p>
                    )}
                    {r.libraryMatches.length > 0 && (
                      <p className="text-xs text-amber-400 mt-0.5">
                        ⚠ Already in library: {r.libraryMatches.map(m => `"${m.name}" — ${m.artist}`).join(", ")}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {result && (
        <div className="rounded-lg bg-green-500/10 border border-green-500/30 p-3">
          <p className="text-sm text-green-400">
            ✓ Added {result.added} track{result.added === 1 ? "" : "s"} — {result.resolvedOnline} matched via Deezer/ReccoBeats,
            {" "}{result.spotifyResolved} via Spotify search
            {result.stillUnresolved > 0 && `, ${result.stillUnresolved} still unresolved (will keep retrying on future heal sweeps)`}.
          </p>
        </div>
      )}
    </div>
  );
}
