"use client";

import { useEffect, useState } from "react";

// Settings → Scheduled Jobs → Backup: the nightly backup of the whole app to a
// Samba share (scripts/pacesync_backup.py). Mirrors lib/backup-settings.ts.
interface State {
  supported: boolean;
  enabled: boolean;
  time: string;
  keepDays: number;
  host: string;
  share: string;
  folder: string;
  username: string;
  hasPassword: boolean;
  running: boolean;
  nextRunAt: string | null;
  last: {
    ok: boolean; finishedAt?: string; startedAt?: string; seconds?: number;
    archiveBytes?: number; daily?: number; shareFreeGB?: number; error?: string;
  } | null;
}

const INPUT = "w-full rounded-lg bg-slate-800 border border-slate-700 text-sm px-3 py-2 text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500";
const BUTTON = "rounded-lg border border-white/10 bg-slate-800/60 hover:bg-slate-700/60 disabled:opacity-50 text-xs font-medium px-3 py-2 text-slate-200 transition-colors";

function when(iso?: string | null): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function BackupSettingsCard() {
  const [state, setState] = useState<State | null>(null);
  const [form, setForm] = useState<State | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  function load() {
    return fetch("/api/settings/backup", { cache: "no-store" }).then(r => r.json()).then((d: State & { error?: string }) => {
      if (d.error) return;
      setState(d);
      return d;
    }).catch(() => undefined);
  }

  useEffect(() => { load().then(d => { if (d) setForm(d); }); }, []);

  // While a backup runs, poll until it finishes.
  useEffect(() => {
    if (!state?.running) return;
    const t = setInterval(() => { load(); }, 10_000);
    return () => clearInterval(t);
  }, [state?.running]);

  async function call(label: string, init: RequestInit, done: string): Promise<boolean> {
    setBusy(label);
    setMessage(null);
    try {
      const res = await fetch("/api/settings/backup", init);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `Failed (${res.status})`);
      setState(d);
      setMessage({ text: done, error: false });
      return true;
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : "Failed", error: true });
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (!form) return;
    const ok = await call("save", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: form.enabled, time: form.time, keepDays: Number(form.keepDays), host: form.host,
        share: form.share, folder: form.folder, username: form.username, password,
      }),
    }, "Saved.");
    if (ok) setPassword("");
  }

  const runNow = () => call("run", { method: "POST" }, "Backup started. A full run takes a few minutes the first time, seconds after that.");

  if (!state || !form) return (
    <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5">
      <h2 className="font-semibold text-base">💾 Backup</h2>
      <p className="text-xs text-slate-500 mt-2">Loading…</p>
    </div>
  );

  const set = <K extends keyof State>(k: K, v: State[K]) => setForm({ ...form, [k]: v });
  const last = state.last;

  return (
    <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5 space-y-4">
      <h2 className="font-semibold text-base">💾 Backup</h2>
      <p className="text-xs text-slate-500">
        Backs up the whole app (code, secrets, database, Garmin data, album art, reverse proxy, crontab and service file) to a
        Samba share, so it can be fully restored. Archives are kept for the number of days below; the Garmin data and album art are
        mirrored incrementally.
      </p>

      {!state.supported ? (
        <p className="text-xs text-slate-400">Backups only run on the Raspberry Pi server.</p>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
            <div>
              <span className="text-slate-500">Last backup</span>{" "}
              <span className={last ? (last.ok ? "text-slate-200" : "text-rose-300") : "text-slate-200"}>
                {state.running ? "running now…" : last ? `${when(last.finishedAt ?? last.startedAt)} (${last.ok ? `OK, ${last.seconds ?? "?"}s` : "failed"})` : "never"}
              </span>
            </div>
            <div><span className="text-slate-500">Next</span> <span className="text-slate-200">{state.enabled ? when(state.nextRunAt) : "off"}</span></div>
            {last?.ok && (
              <div>
                <span className="text-slate-500">Archive</span>{" "}
                <span className="text-slate-200">
                  {last.archiveBytes ? `${(last.archiveBytes / 1048576).toFixed(1)} MB` : "?"}, {last.daily ?? "?"} kept
                  {last.shareFreeGB != null ? `, ${last.shareFreeGB} GB free` : ""}
                </span>
              </div>
            )}
            {last && !last.ok && last.error && <div className="sm:col-span-2 text-rose-300">Error: {last.error}</div>}
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-200">
            <input type="checkbox" checked={form.enabled} onChange={e => set("enabled", e.target.checked)} />
            Run a backup every night
          </label>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs text-slate-400">Time</label>
              <input type="time" value={form.time} onChange={e => set("time", e.target.value)} className={INPUT} />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-slate-400">Keep (days)</label>
              <input type="number" min={3} max={365} value={form.keepDays} onChange={e => set("keepDays", Number(e.target.value))} className={INPUT} />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-slate-400">Server (IP or name)</label>
              <input value={form.host} onChange={e => set("host", e.target.value)} className={INPUT} />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-slate-400">Share</label>
              <input value={form.share} onChange={e => set("share", e.target.value)} className={INPUT} />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-slate-400">Folder on the share</label>
              <input value={form.folder} onChange={e => set("folder", e.target.value)} className={INPUT} />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-slate-400">Username</label>
              <input autoComplete="off" value={form.username} onChange={e => set("username", e.target.value)} className={INPUT} />
            </div>
            <div className="space-y-1.5 col-span-2">
              <label className="text-xs text-slate-400">Password</label>
              <input type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)}
                placeholder={state.hasPassword ? "unchanged" : ""} className={INPUT} />
            </div>
          </div>
          <p className="text-[11px] text-slate-500">
            The share login is stored on the Pi only (not in the database or the repo). The archives contain secrets such as API
            keys, so keep the share private.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <button onClick={save} disabled={!!busy}
              className="rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-sm font-medium px-4 py-2 text-white transition-colors">
              {busy === "save" ? "Saving…" : "Save"}
            </button>
            <button onClick={runNow} disabled={!!busy || state.running} className={BUTTON}>
              {state.running ? "Running…" : "Back up now"}
            </button>
          </div>

          {message && <p className={`text-xs ${message.error ? "text-rose-300" : "text-slate-400"}`}>{message.text}</p>}
        </>
      )}
    </div>
  );
}
