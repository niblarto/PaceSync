"use client";

import { useState, useEffect } from "react";
import { signIn } from "next-auth/react";

// Local credentials (+ TOTP once enrolled) gate that sits in front of the
// Spotify OAuth. On success the server sets a signed cookie the middleware
// checks; the user then continues into the normal Spotify sign-in.

type Stage = "loading" | "credentials" | "totp" | "ready";

export function LoginClient() {
  const [stage, setStage] = useState<Stage>("loading");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/local-auth/status")
      .then(r => r.json())
      .then((d: { authenticated?: boolean }) => {
        setStage(d.authenticated ? "ready" : "credentials");
      })
      .catch(() => setStage("credentials"));
  }, []);

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/local-auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, code: code || undefined }),
      });
      const data = await res.json() as { ok?: boolean; totpRequired?: boolean; error?: string };
      if (data.totpRequired) {
        setStage("totp");
        return;
      }
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Login failed");
      continueToSpotify();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  function continueToSpotify() {
    setStage("ready");
    signIn("spotify", { callbackUrl: "/dashboard" });
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4 relative">
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: "url('/hero.png')" }}
      />
      <div className="absolute inset-0 bg-slate-950/80" />

      <div className="relative z-10 w-full max-w-sm rounded-2xl bg-slate-900/90 backdrop-blur-md border border-white/10 p-8 space-y-6">
        <div className="text-center space-y-1">
          <h1 className="text-2xl font-bold text-green-400 tracking-tight">PaceSync</h1>
          <p className="text-sm text-slate-400">
            {stage === "totp" ? "Enter your authenticator code" : "Sign in to continue"}
          </p>
        </div>

        {stage === "loading" && (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        )}

        {stage === "credentials" && (
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-300">Username</label>
              <input
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
                className="w-full rounded-lg bg-slate-800/60 border border-white/10 text-sm px-3 py-2.5 text-slate-100 focus:outline-none focus:ring-1 focus:ring-green-500"
              />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-300">Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoComplete="current-password"
                className="w-full rounded-lg bg-slate-800/60 border border-white/10 text-sm px-3 py-2.5 text-slate-100 focus:outline-none focus:ring-1 focus:ring-green-500"
              />
            </div>
            {error && <p className="text-sm text-red-400">{error}</p>}
            <button
              type="submit"
              disabled={busy || !username || !password}
              className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-green-500 hover:bg-green-400 disabled:opacity-40 text-black font-semibold text-sm px-4 py-2.5 transition-colors"
            >
              {busy ? <><Spinner />Signing in…</> : "Sign in"}
            </button>
          </form>
        )}

        {stage === "totp" && (
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-300">6-digit code</label>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                value={code}
                onChange={e => setCode(e.target.value.replace(/\D/g, ""))}
                autoFocus
                className="w-full rounded-lg bg-slate-800/60 border border-white/10 text-2xl tracking-[0.4em] text-center px-3 py-2.5 text-slate-100 focus:outline-none focus:ring-1 focus:ring-green-500 font-mono"
              />
              <p className="text-xs text-slate-500">From your authenticator app (LastPass Authenticator etc.)</p>
            </div>
            {error && <p className="text-sm text-red-400">{error}</p>}
            <button
              type="submit"
              disabled={busy || code.length !== 6}
              className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-green-500 hover:bg-green-400 disabled:opacity-40 text-black font-semibold text-sm px-4 py-2.5 transition-colors"
            >
              {busy ? <><Spinner />Verifying…</> : "Verify"}
            </button>
          </form>
        )}

        {stage === "ready" && (
          <div className="space-y-4 text-center">
            <p className="text-sm text-slate-400">Signed in — continue with Spotify to load your playlists.</p>
            <button
              onClick={continueToSpotify}
              className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-green-500 hover:bg-green-400 text-black font-semibold text-sm px-4 py-2.5 transition-colors"
            >
              Continue with Spotify
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
