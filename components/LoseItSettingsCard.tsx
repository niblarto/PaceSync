"use client";

import { useEffect, useState } from "react";

// Settings → Nutrition → Lose It!: connect the account the server logs in
// with (to read the food diary), plus sync status and manual syncs.
// Mirrors lib/loseit-food.ts's LoseItStatus.
interface Status {
  connected: boolean;
  email: string | null;
  sessionExpiresAt: string | null;
  importedAt: string | null;
  importedRows: number;
  lastDaySyncAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  foods: number;
  firstDate: string | null;
  lastDate: string | null;
}

const INPUT = "w-full rounded-lg bg-slate-800 border border-slate-700 text-sm px-3 py-2 text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500";
const BUTTON = "rounded-lg border border-white/10 bg-slate-800/60 hover:bg-slate-700/60 disabled:opacity-50 text-xs font-medium px-3 py-2 text-slate-200 transition-colors";

function when(iso: string | null): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

const prettyDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

export function LoseItSettingsCard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    fetch("/api/settings/loseit").then(r => r.json()).then(d => { if (!d.error) setStatus(d); }).catch(() => {});
  }, []);

  async function call(label: string, url: string, init: RequestInit, done: (d: Status & { sync?: { status: string; error?: string } }) => string) {
    setBusy(label);
    setMessage(null);
    try {
      const res = await fetch(url, init);
      const d = await res.json();
      if (d.connected !== undefined) setStatus(d);
      if (!res.ok) throw new Error(d.error || d.sync?.error || `Failed (${res.status})`);
      setMessage({ text: done(d), error: false });
      return true;
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : "Failed", error: true });
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function connect() {
    const ok = await call("connect", "/api/settings/loseit", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }),
    }, d => d.sync?.status === "error" ? `Connected, but the first sync failed: ${d.sync.error}` : `Connected. ${d.foods.toLocaleString()} foods imported.`);
    if (ok) { setPassword(""); setEditing(false); }
  }

  const sync = (full: boolean) => call(full ? "full" : "sync", "/api/loseit/sync", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ full }),
  }, d => full ? `History rebuilt: ${d.foods.toLocaleString()} foods.` : "Synced today.");

  async function disconnect() {
    if (!confirm("Forget the Lose It! login? The food diary already stored here is kept.")) return;
    await call("disconnect", "/api/settings/loseit", { method: "DELETE" }, () => "Disconnected.");
  }

  const showForm = status && (!status.connected || editing);

  return (
    <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5 space-y-4">
      <h2 className="font-semibold text-base">🍽️ Lose It! food diary</h2>
      <p className="text-xs text-slate-500">
        Reads what you log in Lose It! so the Nutrition page can show each day&apos;s foods. Your full history is downloaded
        once; after that only today is re-read (a few KB, hourly and when you open Nutrition), plus yesterday once a day.
      </p>

      {!status ? (
        <p className="text-xs text-slate-500">Loading…</p>
      ) : (
        <>
          {status.connected && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
              <div><span className="text-slate-500">Account</span> <span className="text-slate-200">{status.email}</span></div>
              <div><span className="text-slate-500">Last sync</span> <span className="text-slate-200">{when(status.lastDaySyncAt)}</span></div>
              <div>
                <span className="text-slate-500">Stored</span>{" "}
                <span className="text-slate-200">
                  {status.foods.toLocaleString()} foods{status.firstDate && status.lastDate ? `, ${prettyDate(status.firstDate)} – ${prettyDate(status.lastDate)}` : ""}
                </span>
              </div>
              <div><span className="text-slate-500">History imported</span> <span className="text-slate-200">{when(status.importedAt)}</span></div>
              {status.lastError && (
                <div className="sm:col-span-2 text-rose-300">Last error ({when(status.lastErrorAt)}): {status.lastError}</div>
              )}
            </div>
          )}

          {showForm && (
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-xs text-slate-400">Lose It! email</label>
                  <input type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} className={INPUT} />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs text-slate-400">Password</label>
                  <input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} className={INPUT} />
                </div>
              </div>
              <p className="text-[11px] text-slate-500">
                The password is stored on the PaceSync server so it can log back in when the 14-day Lose It! session runs out.
                Google or Apple sign-in won&apos;t work here; set a password on your Lose It! account first.
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={connect}
                  disabled={!!busy || !email || !password}
                  className="rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-sm font-medium px-4 py-2 text-white transition-colors"
                >
                  {busy === "connect" ? "Connecting… (first import takes a few seconds)" : "Connect"}
                </button>
                {editing && <button onClick={() => setEditing(false)} disabled={!!busy} className={BUTTON}>Cancel</button>}
              </div>
            </div>
          )}

          {status.connected && !editing && (
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={() => sync(false)} disabled={!!busy} className={BUTTON}>{busy === "sync" ? "Syncing…" : "Sync today now"}</button>
              <button onClick={() => sync(true)} disabled={!!busy} className={BUTTON} title="Re-downloads the whole Lose It! export (~1.6 MB) to pick up edits to older days">
                {busy === "full" ? "Rebuilding…" : "Full resync"}
              </button>
              <button onClick={() => { setEditing(true); setEmail(status.email ?? ""); }} disabled={!!busy} className={BUTTON}>Change login</button>
              <button onClick={disconnect} disabled={!!busy} className={`${BUTTON} text-rose-300`}>Disconnect</button>
            </div>
          )}

          {message && <p className={`text-xs ${message.error ? "text-rose-300" : "text-slate-400"}`}>{message.text}</p>}
        </>
      )}
    </div>
  );
}
