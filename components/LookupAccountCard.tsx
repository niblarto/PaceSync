"use client";

import { useEffect, useState } from "react";

// Settings > Integrations: the SECONDARY Spotify account signed in on the read-only lookup app. Lookups
// that need a login (reading an album or playlist for the Song Crawler, checking tracks still exist) use
// it, so they never touch the main account or the main app. It is never used to write anything.
interface Status { configured: boolean; connected: boolean; redirectUri: string; clientIdHint: string | null; credentialsSource: "settings" | "env" | null }

export function LookupAccountCard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const load = () => fetch("/api/spotify-lookup-account/status").then(r => r.json()).then((d: Status) => setStatus(d)).catch(() => {});
  useEffect(() => {
    void load();
    const p = new URLSearchParams(window.location.search).get("lookupAccount"); // set when Spotify sends you back here
    if (p) setResult(p);
  }, []);

  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  async function saveCredentials() {
    setSaving(true);
    setSaveMsg(null);
    const res = await fetch("/api/spotify-lookup-account/status", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId, clientSecret }),
    }).catch(() => null);
    const d = res ? await res.json().catch(() => ({})) as { error?: string } : { error: "Couldn't reach the server" };
    setSaving(false);
    if (!res?.ok) { setSaveMsg(d.error ?? "Save failed"); return; }
    setClientId(""); setClientSecret("");
    setSaveMsg("Saved. Now sign in with the account that owns this app.");
    void load();
  }

  async function clearCredentials() {
    await fetch("/api/spotify-lookup-account/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clear: true }) }).catch(() => null);
    setSaveMsg(null);
    void load();
  }

  async function disconnect() {
    await fetch("/api/spotify-lookup-account/status", { method: "DELETE" }).catch(() => null);
    setResult(null);
    void load();
  }

  return (
    <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5 space-y-3">
      <div>
        <h2 className="font-semibold text-base">Secondary Spotify account (lookups)</h2>
        <p className="text-sm text-slate-400 mt-1">
          A separate Spotify account, signed in on the read-only lookup app, for lookups that need a login: reading an album or playlist
          for the Song Crawler, and checking tracks still exist. Those never use your main account or the main app, so they can&apos;t use
          up the allowance for saving playlists. It is read-only: the sign-in asks for no permission to change anything.
        </p>
      </div>
      {!status ? (
        <p className="text-xs text-slate-500">Loading…</p>
      ) : (
        <div className="space-y-2 text-sm">
          <p className="text-slate-300">
            Lookup app: {status.configured ? <span className="text-green-400">✓ credentials set</span> : <span className="text-amber-400">credentials not set</span>}
            {" · "}
            Secondary account: {status.connected ? <span className="text-green-400">✓ signed in</span> : <span className="text-slate-500">not signed in</span>}
          </p>
          {/* The lookup app's credentials (the secret is stored on the server and never shown again). */}
          <div className="space-y-2 rounded-lg border border-white/10 bg-slate-950/30 p-3">
            <p className="text-xs text-slate-400">
              Lookup app credentials{status.clientIdHint ? <> in use: <span className="font-mono text-slate-200">{status.clientIdHint}</span> ({status.credentialsSource === "settings" ? "set here" : "from .env.local"})</> : null}.
              Use the Client ID and Secret of an app owned by the secondary account, so it can sign in without being added under User Management.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input value={clientId} onChange={e => setClientId(e.target.value)} placeholder="Client ID" autoComplete="off"
                className="rounded-lg bg-slate-800/60 border border-white/10 text-sm px-3 py-1.5 text-slate-100 font-mono placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-green-500" />
              <input value={clientSecret} onChange={e => setClientSecret(e.target.value)} placeholder="Client Secret" type="password" autoComplete="new-password"
                className="rounded-lg bg-slate-800/60 border border-white/10 text-sm px-3 py-1.5 text-slate-100 font-mono placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-green-500" />
            </div>
            <div className="flex items-center gap-3">
              <button onClick={() => void saveCredentials()} disabled={saving || !clientId.trim() || !clientSecret.trim()}
                className="rounded-lg bg-slate-700/80 hover:bg-slate-600/80 disabled:opacity-40 text-slate-200 text-sm px-4 py-1.5 transition-colors">
                {saving ? "Saving…" : "Save credentials"}
              </button>
              {status.credentialsSource === "settings" && (
                <button onClick={() => void clearCredentials()} className="text-xs text-slate-500 hover:text-slate-300 underline">Clear (use .env.local)</button>
              )}
              {saveMsg && <span className={`text-xs ${saveMsg.startsWith("Saved") ? "text-green-400" : "text-red-400"}`}>{saveMsg}</span>}
            </div>
          </div>
          {status.configured && !status.connected && (
            <ol className="list-decimal pl-5 text-xs text-slate-400 space-y-1">
              <li>In the lookup app&apos;s settings in the Spotify developer dashboard, add this Redirect URI exactly: <span className="font-mono text-slate-200 break-all">{status.redirectUri}</span></li>
              <li>While that app is in development mode, add the secondary account&apos;s email under User Management.</li>
              <li>Press Sign in and log in as the SECONDARY account (Spotify asks which account; log out of the main one first if it picks it automatically).</li>
            </ol>
          )}
          {status.configured && (
            <div className="flex items-center gap-3">
              <a href="/api/spotify-lookup-account/login" className="rounded-lg bg-green-600 hover:bg-green-500 text-white text-sm font-medium px-4 py-1.5 transition-colors">
                {status.connected ? "Sign in again" : "Sign in"}
              </a>
              {status.connected && <button onClick={() => void disconnect()} className="text-xs text-slate-500 hover:text-slate-300 underline">Sign out</button>}
            </div>
          )}
          {!status.configured && <p className="text-xs text-slate-500">Enter the lookup app&apos;s Client ID and Secret above to enable sign-in.</p>}
          {result && (
            <p className={`text-xs ${result === "connected" ? "text-green-400" : "text-red-400"}`}>
              {result === "connected" ? "Signed in. Lookups that need a login now use the secondary account." : result}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
