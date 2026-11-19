"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

// A daily AI summary panel, as on the Nutrition page: shows the latest summary from `endpoint` (GET), and while a new
// one is due asks the server every minute (POST) until the AI answers. Click the title to minimise; the refresh button
// writes a fresh one now (thinking mode, a few minutes). Each section, or the whole summary, can be taken to the Coach.
// The endpoint answers { summary, due, nextAt, writing, error, result? } (see app/api/health/summary/route.ts).

interface Summary { id: number; createdAt: string; periodStart: string; periodEnd: string; content: string; model: string | null }
interface SummaryState {
  summary: Summary | null; due: boolean; nextAt: string; writing: boolean; error: string | null;
  result?: { status: "fresh" | "writing" | "unavailable"; reason?: string };
}

function inlineMd(text: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**")
      ? <strong key={i} className="text-slate-100 font-semibold">{part.slice(2, -2)}</strong>
      : <span key={i}>{part}</span>);
}

// Splits the summary at its bold/# heading lines; text before the first heading becomes an untitled section.
function summarySections(text: string): { title: string | null; body: string }[] {
  const out: { title: string | null; body: string[] }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const h = line.match(/^\*\*([^*]+)\*\*:?$/) ?? line.match(/^#{1,4}\s+(.*)$/);
    if (h) out.push({ title: h[1].trim(), body: [] });
    else {
      if (!out.length) out.push({ title: null, body: [] });
      out[out.length - 1].body.push(raw);
    }
  }
  return out.map(s => ({ title: s.title, body: s.body.join("\n").trim() })).filter(s => s.title || s.body);
}

function Markdown({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) {
      blocks.push(<ul key={blocks.length} className="list-disc pl-5 space-y-1">{list.map((l, i) => <li key={i}>{inlineMd(l)}</li>)}</ul>);
      list = [];
    }
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const bullet = line.match(/^[-*•]\s+(.*)$/) ?? line.match(/^\d+[.)]\s+(.*)$/);
    if (bullet) { list.push(bullet[1]); continue; }
    flush();
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    if (heading) blocks.push(<h3 key={blocks.length} className="text-slate-100 font-semibold pt-1">{inlineMd(heading[1])}</h3>);
    else blocks.push(<p key={blocks.length}>{inlineMd(line)}</p>);
  }
  flush();
  return <div className="space-y-2 text-sm text-slate-300 leading-relaxed">{blocks}</div>;
}

const whenLabel = (iso: string) => new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function DiscussButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} title={label}
      className="shrink-0 text-[11px] px-2 py-0.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 transition-colors">
      💬 Discuss
    </button>
  );
}

export function AiSummaryPanel({ endpoint, pill, storageKey, subject }: {
  endpoint: string; pill: string; storageKey: string; subject: string; // e.g. "sleep and HRV", used in the message sent to the Coach
}) {
  const router = useRouter();
  const [s, setS] = useState<SummaryState | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [run, setRun] = useState(0);        // bumped by the refresh button to restart polling after a forced rewrite
  const [forcing, setForcing] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try { return window.localStorage.getItem(storageKey) === "1"; } catch { return false; }
  });
  const toggleCollapsed = () => setCollapsed(c => {
    try { window.localStorage.setItem(storageKey, c ? "0" : "1"); } catch {}
    return !c;
  });
  const discuss = (message: string) => {
    try { window.sessionStorage.setItem("coach.discuss", message); } catch {}
    router.push("/coach");
  };

  const poll = useCallback(async (method: "GET" | "POST", force = false) => {
    try {
      const res = await fetch(`${endpoint}${force ? "?force=1" : ""}`, { method });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `Failed (${res.status})`);
      setS(d);
      setFailed(null);
      return d as SummaryState;
    } catch (e) {
      setFailed(e instanceof Error ? e.message : "Failed");
      return null;
    }
  }, [endpoint]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const tick = async (first: boolean) => {
      const d = await poll(first ? "GET" : "POST");
      if (stopped) return;
      if (d && first && d.due && !d.writing) { tick(false); return; } // due: try straight away rather than waiting a minute
      if (d && !d.due && !d.writing) return;                           // up to date until 05:00 tomorrow
      timer = setTimeout(() => tick(false), d?.writing ? 10_000 : 60_000);
    };
    if (run > 0) timer = setTimeout(() => tick(false), 10_000); else tick(true);
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [poll, run]);

  async function regenerate() {
    setForcing(true);
    const d = await poll("POST", true);
    setForcing(false);
    if (d?.writing) setRun(r => r + 1);
  }

  const waiting = s?.due && !s.writing;
  return (
    <section className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5">
      <div className={`flex items-center justify-between gap-3 ${collapsed ? "" : "mb-3"}`}>
        <button onClick={toggleCollapsed} aria-expanded={!collapsed}
          className="flex items-center gap-2 text-sm font-semibold text-slate-300 hover:text-slate-100 transition-colors text-left"
          title={collapsed ? "Show the summary" : "Minimise the summary"}>
          <span className={`text-[10px] text-slate-500 transition-transform ${collapsed ? "-rotate-90" : ""}`}>▼</span>
          <span className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0 bg-purple-500/15 text-base" aria-hidden>🧠</span>
          <span className="text-slate-100">AI summary</span>
          <span className="inline-block text-xs font-medium border rounded-full px-2.5 py-0.5 bg-purple-500/20 text-purple-300 border-purple-500/30">{pill}</span>
        </button>
        <div className="flex items-center gap-3">
          {s?.summary && (
            <span className="text-[11px] text-slate-500 text-right">{whenLabel(s.summary.createdAt)}{s.summary.model ? ` · ${s.summary.model}` : ""}</span>
          )}
          {s?.summary && (
            <DiscussButton label="Discuss the whole summary with the coach" onClick={() => discuss(
              `Let's discuss my ${subject} summary for ${s.summary!.periodStart} to ${s.summary!.periodEnd}:\n\n${s.summary!.content}`,
            )} />
          )}
          <button onClick={regenerate} disabled={forcing || !!s?.writing}
            title="Write a fresh summary now (uses thinking; can take a few minutes)" aria-label="Write a fresh summary now"
            className="text-slate-500 hover:text-slate-200 disabled:opacity-50 transition-colors -m-1 p-1">
            <svg viewBox="0 0 24 24" className={`h-4 w-4 ${forcing || s?.writing ? "animate-spin" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
          </button>
        </div>
      </div>
      {!collapsed && <>
        {s?.writing && <p className="text-xs text-emerald-300 mb-3 animate-pulse">Writing the summary (thinking mode; this can take a few minutes)…</p>}
        {s?.result?.status === "unavailable" && !s.due && <p className="text-xs text-amber-300 mb-3">Couldn&apos;t refresh: {s.result.reason}.</p>}
        {waiting && (
          <p className="text-xs text-amber-300 mb-3">
            Today&apos;s summary is due. {s.result?.status === "unavailable" ? `${s.result.reason}; ` : ""}checking again every minute.
          </p>
        )}
        {s?.error && !s.writing && <p className="text-xs text-rose-300 mb-3">Last attempt failed: {s.error}</p>}
        {failed && <p className="text-xs text-rose-300 mb-3">{failed}</p>}
        {!s ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : s.summary ? (
          <>
            <div className="space-y-3">
              {summarySections(s.summary.content).map((sec, i) => (
                <div key={i} className={sec.title ? "border-l-2 border-purple-500/40 pl-3" : ""}>
                  {sec.title && (
                    <div className="flex items-center justify-between gap-3 mb-1">
                      <h3 className="text-sm font-semibold text-slate-100">{sec.title}</h3>
                      <DiscussButton label={`Discuss "${sec.title}" with the coach`} onClick={() => discuss(
                        `Let's discuss the "${sec.title}" section of my ${subject} summary for ${s.summary!.periodStart} to ${s.summary!.periodEnd}:\n\n${sec.body}`,
                      )} />
                    </div>
                  )}
                  {sec.body && <Markdown text={sec.body} />}
                </div>
              ))}
            </div>
            {!s.due && <p className="text-[11px] text-slate-500 mt-3">Next summary from {whenLabel(s.nextAt)}.</p>}
          </>
        ) : (
          <p className="text-sm text-slate-500">No summary yet.</p>
        )}
      </>}
    </section>
  );
}
