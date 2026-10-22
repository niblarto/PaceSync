"use client";

import { useEffect, useState } from "react";

interface Status { configured: boolean; savedAt: string | null; tokenValidUntil: string | null }

// Settings -> Integrations: Garmin Connect Personal API key. The key is
// write-only from here — the page only ever learns whether one is saved.
export function GarminPersonalApiCard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    fetch("/api/settings/garmin-personal-api").then(r => r.json()).then(d => { if (!d.error) setStatus(d); }).catch(() => {});
  }, []);

  async function submit(body: object) {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/settings/garmin-personal-api", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await res.json() as Status & { ok?: boolean; message?: string; error?: string };
      setStatus({ configured: d.configured, savedAt: d.savedAt, tokenValidUntil: d.tokenValidUntil });
      setResult(d.ok ? { ok: true, text: d.message ?? "Connected" } : { ok: false, text: d.error ?? "Test failed" });
      if (d.ok) setKey("");
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : "Request failed" });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setConfirmRemove(false);
    await fetch("/api/settings/garmin-personal-api", { method: "DELETE" }).catch(() => {});
    setStatus({ configured: false, savedAt: null, tokenValidUntil: null });
    setResult(null);
  }

  return (
    <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5 space-y-4">
      <div>
        <h2 className="font-semibold text-base">Garmin Personal API</h2>
        <p className="text-sm text-slate-400 mt-1">
          Garmin&apos;s official access to your own data — adds HRV and interval laps for the Coach on top of GarminDB.
          Create a key in Garmin Connect Web (Personal API Key page); it&apos;s shown once and lasts up to a year.
        </p>
      </div>
      <div className="flex items-center gap-1.5 text-xs">
        <span className={`w-1.5 h-1.5 rounded-full ${status?.configured ? "bg-green-400" : "bg-slate-600"}`} />
        <span className={status?.configured ? "text-green-400" : "text-slate-500"}>
          {status == null ? "Loading…" : status.configured
            ? `Key saved ${status.savedAt ? new Date(status.savedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : ""}`
            : "No key saved"}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="password"
          value={key}
          onChange={e => setKey(e.target.value)}
          placeholder={status?.configured ? "•••••••••••••••• (saved — paste to replace)" : "Paste your Personal API key"}
          autoComplete="off"
          className="flex-1 rounded-lg bg-slate-800/60 border border-white/10 text-sm px-3 py-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-sky-500 font-mono"
        />
        <button
          onClick={() => submit({ apiKey: key })}
          disabled={busy || !key.trim()}
          className="rounded-lg bg-slate-700/80 hover:bg-slate-600/80 disabled:opacity-40 text-slate-200 font-medium text-sm px-4 py-2 shrink-0"
        >
          {busy && key.trim() ? "Saving…" : "Save & test"}
        </button>
      </div>
      {status?.configured && (
        <div className="flex items-center gap-3 text-xs">
          <button onClick={() => submit({ test: true })} disabled={busy} className="text-sky-400 hover:text-sky-300 underline disabled:opacity-40">
            {busy && !key.trim() ? "Testing…" : "Test connection"}
          </button>
          {confirmRemove ? (
            <span className="flex items-center gap-2">
              <button onClick={remove} className="text-red-300 hover:text-red-200">Confirm remove</button>
              <button onClick={() => setConfirmRemove(false)} className="text-slate-500 hover:text-slate-300">Cancel</button>
            </span>
          ) : (
            <button onClick={() => setConfirmRemove(true)} className="text-slate-500 hover:text-red-300">Remove key</button>
          )}
        </div>
      )}
      {result && <p className={`text-xs ${result.ok ? "text-green-400" : "text-red-400"}`}>{result.text}</p>}
    </div>
  );
}
