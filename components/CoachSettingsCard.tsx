"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Provider = "local" | "claude" | "gemini";
interface CoachConfig { provider: Provider; claudeModel: string; claudeEffort: string; geminiModel: string; ollamaModel: string; fallbackToLocal: boolean }

const SELECT = "w-full rounded-lg bg-slate-800 border border-slate-700 text-sm px-3 py-2 text-slate-100 disabled:opacity-40 focus:outline-none focus:ring-1 focus:ring-emerald-500";

// Settings -> Integrations: which AI the Coach page uses. Separate from the
// AI DJ's choice; shares its API keys and the PC running the local model.
// Ollama web search key for the Coach's 🌐 button (saved on the server;
// only a hint of it is ever shown back).
function WebSearchKey() {
  const [state, setState] = useState<{ hasKey: boolean; hint: string | null } | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    fetch("/api/settings/web-search").then(r => r.json()).then(d => { if (!d.error) setState(d); }).catch(() => {});
  }, []);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/settings/web-search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: input }) });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `Save failed (${res.status})`);
      setState({ hasKey: true, hint: d.hint });
      setInput("");
      setMsg({ ok: true, text: `Saved and tested: the search returned ${d.testResults} result${d.testResults === 1 ? "" : "s"}.` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Save failed" });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    await fetch("/api/settings/web-search", { method: "DELETE" }).catch(() => {});
    setState({ hasKey: false, hint: null });
    setMsg(null);
    setBusy(false);
  }

  return (
    <div className="space-y-2 border-t border-white/10 pt-4">
      <div className="text-xs font-medium text-slate-300">🌐 Web search key (Ollama)</div>
      <p className="text-xs text-slate-500">
        Lets the 🌐 button on the Coach page search the web. Free key from{" "}
        <a href="https://ollama.com/settings/keys" target="_blank" rel="noopener noreferrer" className="text-sky-300 underline">ollama.com/settings/keys</a>.
        The search results are then answered by the AI picked above.
      </p>
      {state?.hasKey && (
        <div className="flex items-center gap-3 text-xs">
          <span className="text-emerald-300">✓ Key saved ({state.hint})</span>
          <button onClick={remove} disabled={busy} className="text-slate-500 hover:text-red-300 disabled:opacity-50">Remove</button>
        </div>
      )}
      <div className="flex gap-2">
        <input type="password" value={input} onChange={e => setInput(e.target.value)} placeholder={state?.hasKey ? "Paste a new key to replace it" : "Paste your Ollama API key"}
          autoComplete="off" className={SELECT} />
        <button onClick={save} disabled={busy || !input.trim()}
          className="shrink-0 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-medium px-3 py-2">
          {busy ? "Testing…" : "Save"}
        </button>
      </div>
      {msg && <p className={`text-xs ${msg.ok ? "text-emerald-300" : "text-red-400"}`}>{msg.text}</p>}
    </div>
  );
}

// API Ninjas recipe API key for Nutrition → Food diary → "Create meal" (saved on the server;
// only a hint of it is ever shown back).
function RecipeApiKey() {
  const [state, setState] = useState<{ hasKey: boolean; hint: string | null } | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    fetch("/api/settings/recipe-api").then(r => r.json()).then(d => { if (!d.error) setState(d); }).catch(() => {});
  }, []);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/settings/recipe-api", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: input }) });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `Save failed (${res.status})`);
      setState({ hasKey: true, hint: d.hint });
      setInput("");
      setMsg({ ok: true, text: `Saved and tested: the search returned ${d.testResults} recipe${d.testResults === 1 ? "" : "s"}.` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Save failed" });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    await fetch("/api/settings/recipe-api", { method: "DELETE" }).catch(() => {});
    setState({ hasKey: false, hint: null });
    setMsg(null);
    setBusy(false);
  }

  return (
    <div className="space-y-2 border-t border-white/10 pt-4">
      <div className="text-xs font-medium text-slate-300">🍳 Recipe API key (API Ninjas)</div>
      <p className="text-xs text-slate-500">
        Gives “Create meal” on the Nutrition page real recipes to take ideas from, alongside the web search. Key from{" "}
        <a href="https://api-ninjas.com/profile" target="_blank" rel="noopener noreferrer" className="text-sky-300 underline">api-ninjas.com/profile</a>.
      </p>
      {state?.hasKey && (
        <div className="flex items-center gap-3 text-xs">
          <span className="text-emerald-300">✓ Key saved ({state.hint})</span>
          <button onClick={remove} disabled={busy} className="text-slate-500 hover:text-red-300 disabled:opacity-50">Remove</button>
        </div>
      )}
      <div className="flex gap-2">
        <input type="password" value={input} onChange={e => setInput(e.target.value)} placeholder={state?.hasKey ? "Paste a new key to replace it" : "Paste your API Ninjas key"}
          autoComplete="off" className={SELECT} />
        <button onClick={save} disabled={busy || !input.trim()}
          className="shrink-0 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-medium px-3 py-2">
          {busy ? "Testing…" : "Save"}
        </button>
      </div>
      {msg && <p className={`text-xs ${msg.ok ? "text-emerald-300" : "text-red-400"}`}>{msg.text}</p>}
    </div>
  );
}

// FatSecret Platform API credentials for "Create meal" (saved on the server; only a hint of the id is ever shown back).
function FatSecretKey() {
  const [state, setState] = useState<{ hasKey: boolean; hint: string | null } | null>(null);
  const [id, setId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    fetch("/api/settings/fatsecret").then(r => r.json()).then(d => { if (!d.error) setState(d); }).catch(() => {});
  }, []);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/settings/fatsecret", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId: id, clientSecret: secret }) });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `Save failed (${res.status})`);
      setState({ hasKey: true, hint: d.hint });
      setId(""); setSecret("");
      setMsg({ ok: true, text: `Saved and tested: the search returned ${d.testResults} recipe${d.testResults === 1 ? "" : "s"}.` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Save failed" });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    await fetch("/api/settings/fatsecret", { method: "DELETE" }).catch(() => {});
    setState({ hasKey: false, hint: null });
    setMsg(null);
    setBusy(false);
  }

  return (
    <div className="space-y-2 border-t border-white/10 pt-4">
      <div className="text-xs font-medium text-slate-300">🥗 FatSecret recipes</div>
      <p className="text-xs text-slate-500">
        A second recipe source for “Create meal”: recipes near your remaining calories, with their macros. Client ID and secret from{" "}
        <a href="https://platform.fatsecret.com/my-account/api-key" target="_blank" rel="noopener noreferrer" className="text-sky-300 underline">platform.fatsecret.com</a>.
        FatSecret only answers whitelisted IP addresses, so add this Pi&apos;s public IP to the app there first.
      </p>
      {state?.hasKey && (
        <div className="flex items-center gap-3 text-xs">
          <span className="text-emerald-300">✓ Credentials saved (ID {state.hint})</span>
          <button onClick={remove} disabled={busy} className="text-slate-500 hover:text-red-300 disabled:opacity-50">Remove</button>
        </div>
      )}
      <div className="flex gap-2">
        <input value={id} onChange={e => setId(e.target.value)} placeholder="Client ID" autoComplete="off" className={SELECT} />
        <input type="password" value={secret} onChange={e => setSecret(e.target.value)} placeholder="Client secret" autoComplete="off" className={SELECT} />
        <button onClick={save} disabled={busy || !id.trim() || !secret.trim()}
          className="shrink-0 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-medium px-3 py-2">
          {busy ? "Testing…" : "Save"}
        </button>
      </div>
      {msg && <p className={`text-xs ${msg.ok ? "text-emerald-300" : "text-red-400"}`}>{msg.text}</p>}
    </div>
  );
}

// Switch for "Create meal" reading recipes straight from bbcgoodfood.com (no API or key). Off by default.
function BbcGoodFoodToggle() {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/settings/bbc-good-food").then(r => r.json()).then(d => { if (typeof d.enabled === "boolean") setOn(d.enabled); }).catch(() => {});
  }, []);

  async function toggle(enabled: boolean) {
    setBusy(true);
    try {
      const res = await fetch("/api/settings/bbc-good-food", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) });
      if (res.ok) setOn(enabled);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 border-t border-white/10 pt-4">
      <div className="text-xs font-medium text-slate-300">🇬🇧 BBC Good Food recipes</div>
      <label className="flex items-start gap-2 text-xs text-slate-300">
        <input type="checkbox" className="mt-0.5" checked={!!on} disabled={on == null || busy} onChange={e => toggle(e.target.checked)} />
        <span>Let “Create meal” read recipes from bbcgoodfood.com: UK recipes with metric amounts and per-serving nutrition, no key needed.</span>
      </label>
      <p className="text-xs text-slate-500">
        It follows the site&apos;s robots.txt: it doesn&apos;t use the site&apos;s search. It reads the recipe list from their sitemaps (once a fortnight), then
        only the few recipe pages a search needs, one at a time with a pause between, and keeps each locally so it is never read twice.
        The first search after switching on takes about half a minute extra. Check the site&apos;s terms are fine for your use.
      </p>
    </div>
  );
}

export function CoachSettingsCard() {
  const [config, setConfig] = useState<CoachConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ollamaModels, setOllamaModels] = useState<{ name: string; sizeBytes: number | null }[] | null>(null);

  useEffect(() => {
    fetch("/api/settings/coach").then(r => r.json()).then(d => { if (!d.error) setConfig(d); }).catch(() => {});
    fetch("/api/settings/llm-test/models").then(r => r.json())
      .then((d: { models?: { name: string; sizeBytes: number | null }[] }) => setOllamaModels(d.models ?? []))
      .catch(() => setOllamaModels([]));
  }, []);

  async function save(patch: Partial<CoachConfig>) {
    if (!config) return;
    const next = { ...config, ...patch };
    setConfig(next);
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/coach", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) });
      if (!res.ok) throw new Error(`Save failed (${res.status})`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold text-base">🧠 Coach</h2>
        <Link href="/coach" className="text-xs text-emerald-300 hover:text-emerald-200">Open Coach →</Link>
      </div>
      <p className="text-xs text-slate-500">
        Which AI answers on the Coach page. Chosen separately from the AI DJ, using the same API keys.
        The local model runs on the AI DJ service PC, so that PC must be on.
      </p>
      {!config ? (
        <p className="text-xs text-slate-500">Loading…</p>
      ) : (
        <>
          <div className="flex gap-1.5">
            {([["local", "Local LLM"], ["claude", "Claude"], ["gemini", "Gemini"]] as const).map(([p, label]) => (
              <button
                key={p}
                onClick={() => save({ provider: p })}
                disabled={saving}
                className={`flex-1 rounded-lg border text-xs font-medium px-3 py-2 transition-colors disabled:opacity-50 ${
                  config.provider === p
                    ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-300"
                    : "bg-slate-800/60 border-white/10 text-slate-400 hover:text-slate-200"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {config.provider === "local" && (
            <div className="space-y-1.5">
              <label className="text-xs text-slate-400">Model</label>
              <select value={config.ollamaModel} onChange={e => save({ ollamaModel: e.target.value })} disabled={saving || ollamaModels == null} className={SELECT}>
                <option value="">Service default</option>
                {(ollamaModels ?? []).map(m => (
                  <option key={m.name} value={m.name}>{m.name}{m.sizeBytes != null ? ` — ${(m.sizeBytes / 1e9).toFixed(1)} GB` : ""}</option>
                ))}
                {config.ollamaModel && ollamaModels && !ollamaModels.some(m => m.name === config.ollamaModel) && (
                  <option value={config.ollamaModel}>{config.ollamaModel}</option>
                )}
              </select>
              {ollamaModels?.length === 0 && <p className="text-xs text-slate-500">Couldn&apos;t list models — is the AI DJ service PC on?</p>}
            </div>
          )}

          {config.provider === "claude" && (
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs text-slate-400">Model</label>
                <select value={config.claudeModel} onChange={e => save({ claudeModel: e.target.value })} disabled={saving} className={SELECT}>
                  <option value="claude-sonnet-5">Sonnet 5</option>
                  <option value="claude-opus-4-8">Opus 4.8</option>
                  <option value="claude-haiku-4-5">Haiku 4.5</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-slate-400">Effort</label>
                <select value={config.claudeEffort} onChange={e => save({ claudeEffort: e.target.value })} disabled={saving} className={SELECT}>
                  {["low", "medium", "high", "xhigh", "max"].map(e => <option key={e} value={e}>{e[0].toUpperCase() + e.slice(1)}</option>)}
                </select>
              </div>
            </div>
          )}

          {config.provider === "gemini" && (
            <div className="space-y-1.5">
              <label className="text-xs text-slate-400">Model</label>
              <select value={config.geminiModel} onChange={e => save({ geminiModel: e.target.value })} disabled={saving} className={SELECT}>
                <option value="gemini-3.8-flash">Flash 3.8</option>
                <option value="gemini-3.5-flash-lite">Flash 3.5 Lite</option>
              </select>
            </div>
          )}

          {(config.provider === "claude" || config.provider === "gemini") && (
            <>
              <p className="text-xs text-slate-500">Uses the {config.provider === "claude" ? "Claude" : "Gemini"} API key saved in the AI DJ card above.</p>
              <label className="flex items-start gap-2 text-xs text-slate-300 cursor-pointer">
                <input type="checkbox" checked={config.fallbackToLocal !== false} disabled={saving}
                  onChange={e => save({ fallbackToLocal: e.target.checked })} className="mt-0.5 accent-emerald-500" />
                <span>
                  When {config.provider === "claude" ? "Claude" : "Gemini"}&apos;s limit is reached (free quota, rate limit or no credit), answer with the local model instead.
                  {config.ollamaModel ? ` (${config.ollamaModel})` : ""} The reply is labelled when this happens.
                </span>
              </label>
            </>
          )}
          <WebSearchKey />
          <RecipeApiKey />
          <FatSecretKey />
          <BbcGoodFoodToggle />
          {error && <p className="text-xs text-red-400">{error}</p>}
        </>
      )}
    </div>
  );
}
