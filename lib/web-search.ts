import { getDb } from "@/lib/db";

// Web search for the Coach's 🌐 button, via Ollama's web search API
// (https://ollama.com/api/web_search, free with an Ollama account key). The
// key is saved in Settings → Integrations → Coach and never sent back to the
// browser.

const KEY = "ollama_web_search_key";
const SEARCH_URL = "https://ollama.com/api/web_search";
const MAX_RESULTS = 5;
const MAX_CONTENT_CHARS = 1800; // per result, to keep the prompt a sensible size

export interface WebResult { title: string; url: string; content: string }

export function loadOllamaWebKey(): string | null {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(KEY) as { value_json: string } | undefined;
    const v = row ? JSON.parse(row.value_json) as string : null;
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

export function saveOllamaWebKey(key: string | null): void {
  const db = getDb();
  if (!key) db.prepare("DELETE FROM kv_config WHERE key = ?").run(KEY);
  else db.prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(KEY, JSON.stringify(key.trim()));
}

export async function ollamaWebSearch(query: string, key = loadOllamaWebKey()): Promise<{ ok: true; results: WebResult[] } | { ok: false; error: string }> {
  if (!key) return { ok: false, error: "No Ollama web search key saved (Settings → Integrations → Coach)" };
  try {
    const res = await fetch(SEARCH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: query.slice(0, 400), max_results: MAX_RESULTS }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, error: "Ollama rejected the web search key" };
    if (res.status === 429) return { ok: false, error: "Ollama web search limit reached" };
    if (!res.ok) return { ok: false, error: `Ollama web search failed (${res.status})` };
    const data = await res.json() as { results?: { title?: string; url?: string; content?: string }[] };
    const results = (data.results ?? [])
      .filter(r => r.url)
      .map(r => ({
        title: (r.title || r.url || "").trim(),
        url: r.url!,
        content: (r.content || "").replace(/\s+/g, " ").trim().slice(0, MAX_CONTENT_CHARS),
      }));
    return { ok: true, results };
  } catch (e) {
    return { ok: false, error: e instanceof Error && /timeout|abort/i.test(e.message) ? "Ollama web search timed out" : "Couldn't reach Ollama web search" };
  }
}

// The search results as a block for the coach's system prompt.
export function webResultsBlock(results: WebResult[]): string {
  if (!results.length) return "\n\n### WEB SEARCH RESULTS\n(The search returned nothing useful; say so and answer from what you know.)";
  const items = results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.content}`).join("\n\n");
  return `\n\n### WEB SEARCH RESULTS (searched just now for the athlete's question)
${items}

Use these results for evidence and specifics, cite them inline as [1], [2]…, prefer the more authoritative ones (sports-nutrition and sports-science bodies, peer-reviewed research) and say if they disagree. Tie what you find back to this athlete's own numbers in the TRAINING DATA.`;
}
