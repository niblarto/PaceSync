"use client";

import { useCallback, useEffect, useState } from "react";

// Settings card for the external read-only API (/api/v1): create / revoke keys, links to the Swagger docs, recent requests.

interface KeyInfo { id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }
interface Req { at: string; keyName: string; path: string; status: number; ms: number }

const input = "w-full rounded-lg bg-slate-800/60 border border-white/10 text-sm px-3 py-2 text-slate-100 focus:outline-none focus:ring-1 focus:ring-green-500";
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "never");

export function ApiAccessCard() {
  const [keys, setKeys] = useState<KeyInfo[]>([]);
  const [reqs, setReqs] = useState<Req[]>([]);
  const [name, setName] = useState("muse");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [totpRequired, setTotpRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/settings/api-keys", { cache: "no-store" });
    if (!res.ok) return;
    const d = await res.json() as { keys: KeyInfo[]; requests: Req[] };
    setKeys(d.keys); setReqs(d.requests);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function create() {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/settings/api-keys", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), username: username.trim(), password, totpCode: totp.trim() || undefined }),
      });
      const d = await res.json() as { key?: string; totpRequired?: boolean; error?: string };
      if (!res.ok) throw new Error(d.error ?? "Failed to create the key");
      if (d.totpRequired) { setTotpRequired(true); return; }
      setNewKey(d.key ?? null); setPassword(""); setTotp(""); setTotpRequired(false);
      void load();
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to create the key"); }
    finally { setBusy(false); }
  }

  async function revoke(k: KeyInfo) {
    if (!window.confirm(`Revoke "${k.name}" (${k.prefix}…)? Anything using it stops working immediately.`)) return;
    await fetch(`/api/settings/api-keys?id=${encodeURIComponent(k.id)}`, { method: "DELETE" });
    void load();
  }

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const active = keys.filter(k => !k.revokedAt);

  return (
    <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5 space-y-4">
      <div>
        <h3 className="font-semibold text-slate-200">API access</h3>
        <p className="text-sm text-slate-400 mt-1">
          Lets an outside assistant (such as muse) read your metrics, health, nutrition, activities, plan and music data. Read-only: a key can&apos;t change anything.
          Each key is shown once, can be revoked at any time, and is limited to 60 requests a minute.
        </p>
        <p className="text-sm mt-2 flex flex-wrap gap-x-4 gap-y-1">
          <a className="text-sky-300 hover:text-sky-200 underline" href="/api/v1/docs" target="_blank" rel="noreferrer">Swagger docs</a>
          <a className="text-sky-300 hover:text-sky-200 underline" href="/api/v1/openapi.json" target="_blank" rel="noreferrer">openapi.json</a>
          <span className="text-slate-500 font-mono text-xs self-center">{origin}/api/v1</span>
        </p>
      </div>

      {active.length > 0 && (
        <ul className="divide-y divide-white/5 rounded-lg border border-white/10">
          {active.map(k => (
            <li key={k.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="text-slate-200 truncate">{k.name} <span className="font-mono text-xs text-slate-500">{k.prefix}…</span></p>
                <p className="text-[11px] text-slate-500">Created {when(k.createdAt)} · last used {when(k.lastUsedAt)}</p>
              </div>
              <button onClick={() => revoke(k)} className="shrink-0 rounded-lg border border-white/10 hover:border-red-500/50 hover:text-red-300 text-slate-400 text-xs px-3 py-1.5 transition-colors">Revoke</button>
            </li>
          ))}
        </ul>
      )}

      {newKey ? (
        <div className="space-y-2">
          <p className="text-sm text-amber-400">⚠ This key won&apos;t be shown again. Copy it into muse now.</p>
          <input readOnly value={newKey} onFocus={e => e.currentTarget.select()} className={`${input} font-mono text-xs`} />
          <div className="flex gap-2">
            <button onClick={() => navigator.clipboard?.writeText(newKey)} className="rounded-lg border border-white/10 hover:border-green-500/40 hover:text-green-300 text-slate-300 font-medium text-sm px-5 py-2 transition-colors">Copy</button>
            <button onClick={() => setNewKey(null)} className="rounded-lg border border-white/10 hover:border-white/20 text-slate-400 font-medium text-sm px-5 py-2 transition-colors">Done</button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-slate-400">New key: re-enter your password (and authenticator code if 2FA is on) to confirm.</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div><label className="block text-sm font-medium text-slate-300 mb-1">Key name</label><input className={input} value={name} onChange={e => setName(e.target.value)} /></div>
            <div><label className="block text-sm font-medium text-slate-300 mb-1">Username</label><input className={input} value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" /></div>
            <div><label className="block text-sm font-medium text-slate-300 mb-1">Password</label><input type="password" className={input} value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" /></div>
          </div>
          {totpRequired && (
            <div><label className="block text-sm font-medium text-slate-300 mb-1">Authenticator code</label>
              <input inputMode="numeric" className={`${input} w-40 font-mono`} value={totp} onChange={e => setTotp(e.target.value)} placeholder="123456" /></div>
          )}
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button onClick={create} disabled={busy || !username.trim() || !password}
            className="rounded-lg bg-slate-700/80 hover:bg-slate-600/80 disabled:opacity-40 text-slate-200 font-medium text-sm px-5 py-2 transition-colors">
            {busy ? "Creating…" : "Create API key"}
          </button>
        </div>
      )}

      <div className="pt-2 border-t border-white/5">
        <button onClick={() => { setShowLog(s => !s); void load(); }} className="text-sm text-slate-400 hover:text-slate-200 underline">{showLog ? "Hide" : "Show"} recent requests</button>
        {showLog && (reqs.length === 0 ? <p className="text-sm text-slate-500 mt-2">No requests yet.</p> : (
          <table className="mt-2 w-full text-xs text-slate-400">
            <tbody>
              {reqs.map((r, i) => (
                <tr key={i} className="border-t border-white/5">
                  <td className="py-1 pr-3 whitespace-nowrap">{when(r.at)}</td><td className="pr-3">{r.keyName}</td>
                  <td className="pr-3 font-mono text-slate-300 truncate max-w-[16rem]">{r.path}</td>
                  <td className={`pr-3 ${r.status >= 400 ? "text-red-400" : "text-green-400"}`}>{r.status}</td><td className="text-right">{r.ms} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </div>
    </div>
  );
}
