"use client";

import { useEffect, useState } from "react";

// Settings → Integrations: OpenRouteService key for the Route Finder's street
// routing (saved on the server; only a hint of it is ever shown back).

const INPUT = "w-full rounded-lg bg-slate-800 border border-slate-700 text-sm px-3 py-2 text-slate-100 disabled:opacity-40 focus:outline-none focus:ring-1 focus:ring-emerald-500";

export function OrsKeyCard() {
  const [state, setState] = useState<{ hasKey: boolean; hint: string | null } | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    fetch("/api/settings/route-ors-key").then(r => r.json()).then(d => { if (!d.error) setState(d); }).catch(() => {});
  }, []);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/settings/route-ors-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: input }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `Save failed (${res.status})`);
      setState({ hasKey: true, hint: d.hint });
      setInput("");
      setMsg({ ok: true, text: "Saved and tested: OpenRouteService accepted the key." });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Save failed" });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    await fetch("/api/settings/route-ors-key", { method: "DELETE" }).catch(() => {});
    setState({ hasKey: false, hint: null });
    setMsg(null);
    setBusy(false);
  }

  return (
    <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5 space-y-3">
      <div>
        <h2 className="font-semibold text-base">🗺️ Route Finder · street routing (OpenRouteService)</h2>
        <p className="text-sm text-slate-400 mt-1">
          Lets the Route Finder snap routes to real streets and build new ones from a start and end point.
          Free key from{" "}
          <a href="https://openrouteservice.org/dev/#/signup" target="_blank" rel="noopener noreferrer" className="text-sky-300 underline">openrouteservice.org</a>{" "}
          (about 2,000 requests a day). The start, end and waypoints of a route are sent to openrouteservice.org when you use it.
        </p>
      </div>
      {state?.hasKey && (
        <div className="flex items-center gap-3 text-xs">
          <span className="text-emerald-300">✓ Key saved ({state.hint})</span>
          <button onClick={remove} disabled={busy} className="text-slate-500 hover:text-red-300 disabled:opacity-50">Remove</button>
        </div>
      )}
      <div className="flex gap-2">
        <input
          type="password" value={input} onChange={e => setInput(e.target.value)}
          placeholder={state?.hasKey ? "Paste a new key to replace it" : "Paste your ORS API key"}
          autoComplete="off" className={INPUT}
        />
        <button
          onClick={save} disabled={busy || !input.trim()}
          className="shrink-0 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-medium px-3 py-2"
        >
          {busy ? "Testing…" : "Save"}
        </button>
      </div>
      {msg && <p className={`text-xs ${msg.ok ? "text-emerald-300" : "text-red-400"}`}>{msg.text}</p>}
    </div>
  );
}
