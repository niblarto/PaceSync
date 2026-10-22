"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";

interface Msg {
  id: number;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  model: string | null;
  recalled?: string[];
}

interface Report {
  id: number;
  weekStart: string;
  createdAt: string;
  content: string;
  model: string | null;
}

function reportWeek(weekStart: string): string {
  const d = new Date(`${weekStart}T12:00:00`);
  const end = new Date(d);
  end.setDate(end.getDate() + 6);
  const fmt = (x: Date) => x.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return `${fmt(d)} – ${fmt(end)}`;
}

interface Memory {
  id: string;
  dateId: number;
  summary: string;
  keywords: string[];
  createdAt: string;
  models: ("bge" | "minilm")[];
}

function memoryDate(dateId: number): string {
  const s = String(dateId);
  return new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T12:00:00`)
    .toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

const STARTERS = [
  "How did my training go this week?",
  "Review my last run against the plan.",
  "Given my recovery, should I adjust my next session?",
  "Am I on track for my next race?",
];

// ── Minimal Markdown for coach replies (bold, italics, code, lists, headings) ──

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**")) out.push(<strong key={k++} className="text-slate-50 font-semibold">{t.slice(2, -2)}</strong>);
    else if (t.startsWith("`")) out.push(<code key={k++} className="px-1 rounded bg-slate-800 text-emerald-300 text-[0.85em]">{t.slice(1, -1)}</code>);
    else out.push(<em key={k++}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) {
      blocks.push(<p key={k++} className="font-semibold text-slate-100 mt-1">{inline(h[2])}</p>);
      i++;
      continue;
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items: { depth: number; text: string }[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
        const depth = (lines[i].match(/^\s*/)?.[0].length ?? 0) >= 2 ? 1 : 0;
        items.push({ depth, text: lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, "") });
        i++;
      }
      const Tag = ordered ? "ol" : "ul";
      blocks.push(
        <Tag key={k++} className={`${ordered ? "list-decimal" : "list-disc"} pl-5 space-y-1`}>
          {items.map((it, j) => <li key={j} className={it.depth ? "ml-4 list-[circle]" : ""}>{inline(it.text)}</li>)}
        </Tag>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(<p key={k++}>{para.map((p, j) => <Fragment key={j}>{j > 0 && <br />}{inline(p)}</Fragment>)}</p>);
  }
  return <div className="space-y-2.5">{blocks}</div>;
}

function timeLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return d.toLocaleString("en-GB", today ? { hour: "2-digit", minute: "2-digit" } : { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function CoachClient() {
  const [messages, setMessages] = useState<Msg[] | null>(null);
  const [model, setModel] = useState("");
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [context, setContext] = useState<{ text: string; generatedAt: string; runCount: number } | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [summarising, setSummarising] = useState(false);
  const [highlight, setHighlight] = useState<string[]>([]);
  const [confirmForget, setConfirmForget] = useState<string | null>(null);
  const [reports, setReports] = useState<Report[] | null>(null);
  const [reportIdx, setReportIdx] = useState(0);
  const [writing, setWriting] = useState(false);
  const [writingSecs, setWritingSecs] = useState(0);
  const [reportError, setReportError] = useState<string | null>(null);
  const [confirmDeleteReport, setConfirmDeleteReport] = useState(false);

  const loadReports = useCallback(() => {
    fetch("/api/coach/reports")
      .then(r => r.json())
      .then((d: { reports?: Report[]; writing?: boolean; error?: string | null }) => {
        setReports(prev => {
          // A new report landed — show it.
          if (prev && d.reports?.length && d.reports[0].id !== prev[0]?.id) setReportIdx(0);
          return d.reports ?? [];
        });
        setWriting(was => {
          if (was && !d.writing) {
            if (d.error) setReportError(d.error);
            loadMemoriesRef.current?.();
          }
          return !!d.writing;
        });
      })
      .catch(() => setReports(r => r ?? []));
  }, []);
  const loadMemoriesRef = useRef<(() => void) | null>(null);
  useEffect(() => { loadReports(); }, [loadReports]);
  // While a report is being written, check back until it's done.
  useEffect(() => {
    if (!writing) return;
    const t = setInterval(loadReports, 5000);
    return () => clearInterval(t);
  }, [writing, loadReports]);
  useEffect(() => {
    if (!writing) return;
    setWritingSecs(0);
    const t = setInterval(() => setWritingSecs(s => s + 1), 1000);
    return () => clearInterval(t);
  }, [writing]);

  async function writeReport() {
    setReportError(null);
    try {
      const res = await fetch("/api/coach/reports", { method: "POST" });
      if (!res.ok) throw new Error(`Error ${res.status}`);
      setWriting(true);
    } catch (e) {
      setReportError(e instanceof Error ? e.message : "Couldn't start the report");
    }
  }

  async function deleteReport(id: number) {
    setConfirmDeleteReport(false);
    await fetch(`/api/coach/reports?id=${id}`, { method: "DELETE" }).catch(() => {});
    setReports(r => (r ?? []).filter(x => x.id !== id));
    setReportIdx(0);
  }
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetch("/api/coach/chat")
      .then(r => r.json())
      .then((d: { messages?: Msg[]; model?: string; error?: string }) => {
        if (d.error) throw new Error(d.error);
        setMessages(d.messages ?? []);
        setModel(d.model ?? "");
      })
      .catch(e => { setMessages([]); setError(e instanceof Error ? e.message : "Couldn't load the conversation"); });
  }, []);

  const loadContext = useCallback(() => {
    setContextLoading(true);
    fetch("/api/coach/context")
      .then(r => r.json())
      .then(d => { if (!d.error) setContext(d); })
      .catch(() => {})
      .finally(() => setContextLoading(false));
  }, []);
  useEffect(() => { loadContext(); }, [loadContext]);

  const loadMemories = useCallback(() => {
    fetch("/api/coach/memory")
      .then(r => r.json())
      .then((d: { memories?: Memory[]; summarising?: boolean }) => {
        setMemories(d.memories ?? []);
        setSummarising(!!d.summarising);
      })
      .catch(() => setMemories([]));
  }, []);
  useEffect(() => { loadMemories(); }, [loadMemories]);
  useEffect(() => { loadMemoriesRef.current = loadMemories; }, [loadMemories]);
  // While a finished conversation is being written to memory, check back
  // until it lands.
  useEffect(() => {
    if (!summarising) return;
    const t = setInterval(loadMemories, 4000);
    return () => clearInterval(t);
  }, [summarising, loadMemories]);

  async function forget(id: string) {
    setConfirmForget(null);
    await fetch(`/api/coach/memory?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
    loadMemories();
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  useEffect(() => {
    if (!pending) return;
    setElapsed(0);
    const t = setInterval(() => setElapsed(s => s + 1), 1000);
    return () => clearInterval(t);
  }, [pending]);

  async function send(text?: string) {
    const msg = (text ?? input).trim();
    if (!msg || pending) return;
    setError(null);
    setPending(msg);
    setInput("");
    try {
      const res = await fetch("/api/coach/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg }),
      });
      const d = await res.json() as { userMessage?: Msg; reply?: Msg; error?: string };
      if (!res.ok || !d.reply || !d.userMessage) throw new Error(d.error ?? `Coach error ${res.status}`);
      setMessages(m => [...(m ?? []), d.userMessage!, d.reply!]);
      if (d.reply.model) setModel(d.reply.model);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The coach couldn't reply");
      setInput(msg);
    } finally {
      setPending(null);
      inputRef.current?.focus();
    }
  }

  async function newConversation() {
    setConfirmNew(false);
    const hadReply = !!messages?.some(m => m.role === "assistant");
    await fetch("/api/coach/session", { method: "DELETE" }).catch(() => {});
    setMessages([]);
    setError(null);
    setHighlight([]);
    if (hadReply) setSummarising(true);
    loadContext();
    loadMemories();
  }

  const empty = messages != null && messages.length === 0 && !pending;

  return (
    <div className="relative isolate min-h-screen flex flex-col text-slate-100">
      <div aria-hidden className="fixed inset-0 -z-10 bg-slate-950 bg-cover bg-center bg-no-repeat pointer-events-none"
        style={{ backgroundImage: "linear-gradient(rgba(2,6,23,0.8), rgba(2,6,23,0.8)), url('/dashboard-hero.png')" }} />
      <header className="border-b border-white/5 bg-slate-950/70 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-[100rem] mx-auto px-4 h-14 flex items-center justify-between gap-3">
          <Link href="/dashboard" className="text-sm text-slate-500 hover:text-slate-300 transition-colors">← Dashboard</Link>
          <span className="font-bold text-green-400 text-lg tracking-tight">🧠 Coach</span>
          <Link href="/settings?tab=integrations" className="text-xs text-slate-500 hover:text-slate-300 transition-colors truncate max-w-[40%]" title="Change the Coach's AI in Settings">
            {model || " "}
          </Link>
        </div>
      </header>

      <div className="flex-1 max-w-[100rem] w-full mx-auto px-4 py-6 grid grid-cols-1 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-6 items-start">
        {/* Chat */}
        <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 flex flex-col h-[calc(100vh-8rem)] min-h-[28rem]">
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
            <h2 className="font-semibold text-sm">Conversation</h2>
            {confirmNew ? (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-slate-400">Start over?</span>
                <button onClick={newConversation} className="px-2 py-1 rounded-md bg-red-500/20 border border-red-500/40 text-red-300 hover:bg-red-500/30">Confirm</button>
                <button onClick={() => setConfirmNew(false)} className="px-2 py-1 rounded-md text-slate-400 hover:text-slate-200">Cancel</button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmNew(true)}
                disabled={!messages?.length || !!pending}
                className="text-xs px-2.5 py-1 rounded-lg border border-white/10 bg-slate-800/60 text-slate-300 hover:text-slate-100 disabled:opacity-40"
              >
                New conversation
              </button>
            )}
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
            {messages == null && <p className="text-sm text-slate-500">Loading…</p>}
            {empty && (
              <div className="h-full flex flex-col items-center justify-center text-center gap-4 py-8">
                <p className="text-slate-300 text-sm max-w-md">
                  Ask about your training. The coach reads your Garmin runs, recovery, Runna plan and races before every answer.
                </p>
                <div className="flex flex-wrap justify-center gap-2 max-w-xl">
                  {STARTERS.map(s => (
                    <button key={s} onClick={() => send(s)} className="text-xs px-3 py-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20">
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages?.map(m => (
              <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                  m.role === "user"
                    ? "bg-emerald-600/25 border border-emerald-500/30 text-slate-100 whitespace-pre-wrap"
                    : "bg-slate-800/70 border border-white/10 text-slate-200"
                }`}>
                  {m.role === "user" ? m.content : <Markdown text={m.content} />}
                  <p className="mt-1.5 text-[10px] text-slate-500">
                    {timeLabel(m.createdAt)}{m.model ? ` · ${m.model}` : ""}
                    {!!m.recalled?.length && (
                      <button
                        type="button"
                        onClick={() => setHighlight(h => h.join() === m.recalled!.join() ? [] : m.recalled!)}
                        className="ml-1 text-violet-300 hover:text-violet-200"
                        title="Past sessions the coach recalled for this reply — click to show them"
                      >
                        · 🧠 recalled {m.recalled.length} {m.recalled.length === 1 ? "memory" : "memories"}
                      </button>
                    )}
                  </p>
                </div>
              </div>
            ))}
            {pending && (
              <>
                <div className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl px-4 py-3 text-sm bg-emerald-600/25 border border-emerald-500/30 whitespace-pre-wrap">{pending}</div>
                </div>
                <div className="flex justify-start">
                  <div className="rounded-2xl px-4 py-3 text-sm bg-slate-800/70 border border-white/10 text-slate-400 flex items-center gap-2">
                    <span className="inline-flex gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-bounce" />
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-bounce [animation-delay:150ms]" />
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-bounce [animation-delay:300ms]" />
                    </span>
                    Coach is reviewing your data… {elapsed}s
                  </div>
                </div>
              </>
            )}
          </div>

          {error && <div className="mx-4 mb-2 rounded-lg bg-red-950/50 border border-red-800/50 px-3 py-2 text-red-300 text-xs">{error}</div>}

          <form onSubmit={e => { e.preventDefault(); void send(); }} className="border-t border-white/10 p-3 flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
              rows={2}
              placeholder="Ask your coach… (Enter to send, Shift+Enter for a new line)"
              className="flex-1 resize-none rounded-lg bg-slate-800/70 border border-white/10 text-sm px-3 py-2 text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
            <button type="submit" disabled={!input.trim() || !!pending}
              className="rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-sm font-medium px-4 py-2 h-[3.25rem]">
              Send
            </button>
          </form>
        </div>

        {/* What the coach sees */}
        <div className="space-y-4">
          {(() => {
            const report = reports?.[reportIdx];
            return (
              <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="font-semibold text-sm">📋 Weekly report</h2>
                  <div className="flex items-center gap-2">
                    {reports && reports.length > 1 && (
                      <select
                        value={reportIdx}
                        onChange={e => { setReportIdx(Number(e.target.value)); setConfirmDeleteReport(false); }}
                        className="rounded-md bg-slate-800 border border-white/10 text-xs px-2 py-1 text-slate-200"
                      >
                        {reports.map((r, i) => <option key={r.id} value={i}>{reportWeek(r.weekStart)}</option>)}
                      </select>
                    )}
                    <button
                      onClick={writeReport}
                      disabled={writing}
                      className="text-xs px-2.5 py-1 rounded-lg border border-white/10 bg-slate-800/60 text-slate-300 hover:text-slate-100 disabled:opacity-40"
                      title="Write a report on the last 7 days now (the scheduled one on Sunday evening covers Mon–Sun)"
                    >
                      {writing ? `Writing… ${writingSecs}s` : "Write now"}
                    </button>
                  </div>
                </div>
                {reportError && <p className="text-xs text-red-400">{reportError}</p>}
                {reports == null && <p className="text-xs text-slate-500">Loading…</p>}
                {reports?.length === 0 && !writing && (
                  <p className="text-xs text-slate-500 italic">
                    No reports yet. The coach writes one every Sunday evening (change the time in Settings → Scheduled jobs), or click Write now.
                  </p>
                )}
                {report && (
                  <>
                    <p className="text-xs text-slate-500">
                      Week of {reportWeek(report.weekStart)} · written {timeLabel(report.createdAt)}{report.model ? ` · ${report.model}` : ""}
                    </p>
                    <div className="text-sm text-slate-300 leading-relaxed max-h-[26rem] overflow-y-auto pr-1 bg-slate-950/40 rounded-lg p-3 border border-white/5">
                      <Markdown text={report.content} />
                    </div>
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <button
                        onClick={() => send(`Let's go through the weekly report for ${reportWeek(report.weekStart)}.`)}
                        disabled={!!pending || reportIdx !== 0}
                        title={reportIdx !== 0 ? "The coach only has the latest report to hand" : undefined}
                        className="px-2.5 py-1 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-40"
                      >
                        💬 Discuss with coach
                      </button>
                      {confirmDeleteReport ? (
                        <span className="flex items-center gap-2">
                          <button onClick={() => deleteReport(report.id)} className="text-red-300 hover:text-red-200">Confirm delete</button>
                          <button onClick={() => setConfirmDeleteReport(false)} className="text-slate-500 hover:text-slate-300">Cancel</button>
                        </span>
                      ) : (
                        <button onClick={() => setConfirmDeleteReport(true)} className="text-slate-600 hover:text-red-300">Delete</button>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })()}
          <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-sm">Training data the coach sees</h2>
              <button onClick={loadContext} disabled={contextLoading} className="text-xs text-slate-400 hover:text-slate-200 disabled:opacity-40">
                {contextLoading ? "Loading…" : "↻ Refresh"}
              </button>
            </div>
            {context ? (
              <>
                <p className="text-xs text-slate-500">
                  {context.runCount} runs in the last 4 weeks · rebuilt before every reply
                </p>
                <pre className="text-[11px] leading-relaxed text-slate-400 whitespace-pre-wrap max-h-[22rem] overflow-y-auto font-mono bg-slate-950/50 rounded-lg p-3 border border-white/5">
                  {context.text}
                </pre>
              </>
            ) : (
              <p className="text-xs text-slate-500">{contextLoading ? "Gathering your Garmin, Runna and race data…" : "Not available."}</p>
            )}
          </div>

          <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-sm">🧠 Coaching memory</h2>
              <span className="text-xs text-slate-500">{memories?.length ?? 0} saved</span>
            </div>
            <p className="text-xs text-slate-500">
              Each finished conversation is summarised here. The coach recalls the 3 most relevant from the last 30 days.
            </p>
            {summarising && (
              <p className="text-xs text-violet-300 flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse" />
                Saving the last conversation to memory…
              </p>
            )}
            {memories && memories.length === 0 && !summarising && (
              <p className="text-xs text-slate-500 italic">Nothing yet — start a new conversation after chatting and the last one is saved here.</p>
            )}
            <div className="space-y-2 max-h-[28rem] overflow-y-auto pr-1">
              {memories?.map(m => (
                <div key={m.id} className={`rounded-lg border px-3 py-2 text-xs space-y-1.5 transition-colors ${
                  highlight.includes(m.id) ? "border-violet-400/60 bg-violet-500/10" : "border-white/5 bg-slate-950/40"
                }`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-300 font-medium">{memoryDate(m.dateId)}</span>
                    {confirmForget === m.id ? (
                      <span className="flex items-center gap-1.5">
                        <button onClick={() => forget(m.id)} className="text-red-300 hover:text-red-200">Forget</button>
                        <button onClick={() => setConfirmForget(null)} className="text-slate-500 hover:text-slate-300">Cancel</button>
                      </span>
                    ) : (
                      <button onClick={() => setConfirmForget(m.id)} className="text-slate-600 hover:text-red-300" title="Forget this memory">✕</button>
                    )}
                  </div>
                  <p className="text-slate-400 leading-relaxed">{m.summary}</p>
                  {!!m.keywords.length && (
                    <div className="flex flex-wrap gap-1">
                      {m.keywords.map(k => <span key={k} className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">{k}</span>)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
