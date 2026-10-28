"use client";

import { useCallback, useEffect, useState } from "react";

type Level = "ok" | "warn" | "error" | "info" | "off";
interface StatusItem { label: string; level: Level; detail: string }
interface StatusSection { title: string; note?: string; items: StatusItem[] }
interface StatusReport { generatedAt: string; live: boolean; sections: StatusSection[] }
interface LogLine { at: string; level: "info" | "warn" | "error"; msg: string }
interface LogReply { lines: LogLine[]; counts: { info: number; warn: number; error: number }; total?: number; error?: string }

const DOT: Record<string, string> = {
  ok: "bg-green-500", warn: "bg-amber-400", error: "bg-red-500", info: "bg-sky-400", off: "bg-gray-500",
};
const LOG_TEXT: Record<string, string> = { info: "text-gray-300", warn: "text-amber-300", error: "text-red-400" };

export function StatusTab({ active }: { active: boolean }) {
  const [report, setReport] = useState<StatusReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogReply | null>(null);
  const [logLevel, setLogLevel] = useState<"all" | "warn" | "error">("all");
  const [q, setQ] = useState("");
  const [logsLoading, setLogsLoading] = useState(false);

  const loadReport = useCallback(async (live: boolean) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/settings/status?live=${live ? 1 : 0}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setReport(await res.json());
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't load status");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadLogs = useCallback(async () => {
    setLogsLoading(true);
    try {
      const res = await fetch(`/api/settings/status/logs?hours=24&level=${logLevel}&q=${encodeURIComponent(q)}`, { cache: "no-store" });
      setLogs(await res.json());
    } catch {
      setLogs({ lines: [], counts: { info: 0, warn: 0, error: 0 }, error: "Couldn't load the log" });
    } finally {
      setLogsLoading(false);
    }
  }, [logLevel, q]);

  // Only fetch while the tab is showing; refresh quietly (no external pings) every 30s.
  useEffect(() => {
    if (!active) return;
    loadReport(true);
    const t = setInterval(() => loadReport(false), 30_000);
    return () => clearInterval(t);
  }, [active, loadReport]);

  useEffect(() => {
    if (!active) return;
    const t = setTimeout(loadLogs, q ? 400 : 0);
    return () => clearTimeout(t);
  }, [active, loadLogs, q]);

  const card = "bg-gray-900 border border-gray-800 rounded-xl p-4";

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-gray-500">
          {report ? `Updated ${new Date(report.generatedAt).toLocaleTimeString()}${report.live ? "" : " (external services not re-checked)"}` : "Loading…"}
        </p>
        <button
          onClick={() => { loadReport(true); loadLogs(); }}
          disabled={loading}
          className="px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-sm text-gray-200 disabled:opacity-50"
        >
          {loading ? "Checking…" : "Refresh"}
        </button>
      </div>
      {err && <p className="text-sm text-red-400">{err}</p>}

      {report?.sections.map(s => (
        <section key={s.title} className={card}>
          <h3 className="text-sm font-semibold text-gray-200 mb-1">{s.title}</h3>
          {s.note && <p className="text-xs text-gray-500 mb-2">{s.note}</p>}
          <ul className="divide-y divide-gray-800">
            {s.items.map((it, i) => (
              <li key={i} className="py-2 flex items-start gap-3">
                <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${DOT[it.level] ?? DOT.info}`} />
                <div className="min-w-0">
                  <div className="text-sm text-gray-200">{it.label}</div>
                  <div className="text-xs text-gray-400 break-words">{it.detail}</div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <section className={card}>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <h3 className="text-sm font-semibold text-gray-200">
            Server log, last 24 hours
            {logs && <span className="ml-2 text-xs font-normal text-gray-500">{logs.counts.error} errors · {logs.counts.warn} warnings · {logs.counts.info} other</span>}
          </h3>
          <div className="flex items-center gap-2">
            <button
              onClick={loadLogs}
              disabled={logsLoading}
              className="px-2.5 py-1 rounded-md text-xs bg-gray-800 text-gray-200 hover:bg-gray-700 disabled:opacity-50"
            >
              {logsLoading ? "Refreshing…" : "Refresh"}
            </button>
            {(["all", "warn", "error"] as const).map(l => (
              <button
                key={l}
                onClick={() => setLogLevel(l)}
                className={`px-2.5 py-1 rounded-md text-xs ${logLevel === l ? "bg-green-600 text-white" : "bg-gray-800 text-gray-300 hover:bg-gray-700"}`}
              >
                {l === "all" ? "All" : l === "warn" ? "Warnings+" : "Errors"}
              </button>
            ))}
          </div>
        </div>
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search the log…"
          className="w-full mb-2 px-3 py-1.5 rounded-lg bg-gray-950 border border-gray-800 text-sm text-gray-200 placeholder-gray-600"
        />
        {logs?.error && <p className="text-sm text-red-400">{logs.error}</p>}
        <div className="max-h-[32rem] overflow-y-auto rounded-lg bg-gray-950 p-2 font-mono text-[11px] leading-snug">
          {logsLoading && !logs && <p className="text-gray-500">Loading…</p>}
          {logs && logs.lines.length === 0 && !logs.error && <p className="text-gray-500">No matching log lines.</p>}
          {logs?.lines.map((l, i) => (
            <div key={i} className={`py-0.5 break-words ${LOG_TEXT[l.level]}`}>
              <span className="text-gray-500">{l.at.replace("T", " ").slice(5, 19)} </span>{l.msg}
            </div>
          ))}
        </div>
        {logs?.total != null && logs.total > logs.lines.length && (
          <p className="text-xs text-gray-500 mt-1">Showing the newest {logs.lines.length} of {logs.total} matching lines.</p>
        )}
      </section>
    </>
  );
}
