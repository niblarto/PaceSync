import { join } from "path";
import { spawn } from "child_process";
import { getDb } from "@/lib/db";
import { loadAiDjConfig } from "@/lib/ai-dj-config";

// Coaching memory — port of ai-running-coach's llm/memory.py.
//
// commit: each finished conversation becomes one dated summary, id
// "YYYYMMDD_n" (n = that day's nth session), document text
// "Date: <Month D, YYYY>\nSummary: ...", plus keywords.
// recall: the 3 closest summaries from the last 30 days by meaning, kept
// only if they're actually close (the repo computed that filter but then
// returned the unfiltered list — fixed here), oldest first.
//
// "By meaning" = embeddings. Every memory gets two:
//   bge  — bge-large via Ollama on the AI DJ PC (the repo's model; GPU when
//          there's room), the better one;
//   minilm — all-MiniLM-L6-v2 on the Pi (scripts/coach_embed.py), so recall
//          still works when the PC is off.
// Vectors from different models can't be compared, so recall uses one model
// end to end: PC if it answers, else the Pi. Missing vectors are filled in
// whenever their model is next available.

export type EmbedModel = "bge" | "minilm";

const RECALL_DAYS = 30;
const RECALL_N = 3;
// Repo filter: Chroma L2 distance < 1.0 on unit vectors == cosine > 0.5.
// MiniLM scores run lower than bge for the same relatedness.
const MIN_SIMILARITY: Record<EmbedModel, number> = { bge: 0.5, minilm: 0.3 };
// bge-large's retrieval instruction, prefixed to queries only.
const BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
const PC_TIMEOUT_MS = 8000;
// After the PC fails to answer, don't try it again for a while — saves
// every chat message waiting on a switched-off PC.
const PC_RETRY_AFTER_MS = 2 * 60_000;
const PYTHON = process.platform === "win32" ? "python" : "python3";

let ready = false;
function db() {
  const d = getDb();
  if (!ready) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS coach_memories (
        id TEXT PRIMARY KEY,
        date_id INTEGER NOT NULL,
        session_id INTEGER,
        document TEXT NOT NULL,
        summary TEXT NOT NULL,
        keywords TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS coach_memory_vectors (
        memory_id TEXT NOT NULL,
        model TEXT NOT NULL,
        vector TEXT NOT NULL,
        PRIMARY KEY (memory_id, model)
      );
    `);
    ready = true;
  }
  return d;
}

export interface CoachMemory {
  id: string;
  dateId: number;
  sessionId: number | null;
  document: string;
  summary: string;
  keywords: string[];
  createdAt: string;
  models: EmbedModel[];
}

interface MemoryRow { id: string; date_id: number; session_id: number | null; document: string; summary: string; keywords: string; created_at: string; models: string | null }

function rowToMemory(r: MemoryRow): CoachMemory {
  return {
    id: r.id, dateId: r.date_id, sessionId: r.session_id, document: r.document, summary: r.summary,
    keywords: r.keywords ? r.keywords.split(",").map(k => k.trim()).filter(Boolean) : [],
    createdAt: r.created_at,
    models: (r.models ?? "").split(",").filter((m): m is EmbedModel => m === "bge" || m === "minilm"),
  };
}

const SELECT_MEMORIES = `
  SELECT m.*, (SELECT GROUP_CONCAT(model) FROM coach_memory_vectors v WHERE v.memory_id = m.id) AS models
  FROM coach_memories m`;

export function listMemories(): CoachMemory[] {
  return (db().prepare(`${SELECT_MEMORIES} ORDER BY m.created_at DESC`).all() as MemoryRow[]).map(rowToMemory);
}

export function deleteMemory(id: string): void {
  db().prepare("DELETE FROM coach_memory_vectors WHERE memory_id = ?").run(id);
  db().prepare("DELETE FROM coach_memories WHERE id = ?").run(id);
}

// ── Embedding providers ─────────────────────────────────────────────────────

let pcDownUntil = 0;

async function embedOnPc(texts: string[]): Promise<number[][] | null> {
  if (Date.now() < pcDownUntil) return null;
  const url = loadAiDjConfig()?.url;
  if (!url) return null;
  try {
    const res = await fetch(`${url}/coach/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts }),
      signal: AbortSignal.timeout(PC_TIMEOUT_MS),
    });
    const d = await res.json() as { vectors?: number[][]; error?: string };
    if (!res.ok || !d.vectors) throw new Error(d.error ?? `status ${res.status}`);
    return d.vectors;
  } catch (err) {
    console.warn(`[coach-memory] PC embeddings unavailable (${err instanceof Error ? err.message : err}) — using the Pi`);
    pcDownUntil = Date.now() + PC_RETRY_AFTER_MS;
    return null;
  }
}

function embedOnPi(texts: string[]): Promise<number[][] | null> {
  return new Promise(resolve => {
    const proc = spawn(PYTHON, [join(process.cwd(), "scripts", "coach_embed.py")]);
    const timer = setTimeout(() => proc.kill(), 90_000);
    let out = "";
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("close", () => {
      clearTimeout(timer);
      try {
        const d = JSON.parse(out.trim().split("\n").pop() ?? "") as { vectors?: number[][]; error?: string };
        if (d.error) console.warn(`[coach-memory] Pi embeddings failed: ${d.error}`);
        resolve(d.vectors ?? null);
      } catch {
        resolve(null);
      }
    });
    proc.on("error", () => { clearTimeout(timer); resolve(null); });
    proc.stdin.write(JSON.stringify({ texts }));
    proc.stdin.end();
  });
}

function embed(model: EmbedModel, texts: string[]): Promise<number[][] | null> {
  return model === "bge" ? embedOnPc(texts) : embedOnPi(texts);
}

function memoryEmbedText(m: { document: string; keywords: string }): string {
  return m.keywords ? `${m.document}\nKeywords: ${m.keywords}` : m.document;
}

function storeVector(memoryId: string, model: EmbedModel, vector: number[]): void {
  db().prepare("INSERT INTO coach_memory_vectors (memory_id, model, vector) VALUES (?, ?, ?) ON CONFLICT(memory_id, model) DO UPDATE SET vector = excluded.vector")
    .run(memoryId, model, JSON.stringify(vector));
}

// Embeds any memories that don't yet have a `model` vector. Returns false
// if that model isn't reachable right now.
async function backfill(model: EmbedModel): Promise<boolean> {
  const missing = db().prepare(`
    SELECT id, document, keywords FROM coach_memories
    WHERE id NOT IN (SELECT memory_id FROM coach_memory_vectors WHERE model = ?)
  `).all(model) as { id: string; document: string; keywords: string }[];
  if (!missing.length) return true;
  const vectors = await embed(model, missing.map(memoryEmbedText));
  if (!vectors) return false;
  missing.forEach((m, i) => storeVector(m.id, model, vectors[i]));
  console.log(`[coach-memory] filled in ${missing.length} ${model} vector(s)`);
  return true;
}

// ── commit / recall ─────────────────────────────────────────────────────────

function dateId(d: Date): number {
  return Number(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`);
}

export async function commitSessionToMemory(summary: string, keywords: string[], sessionId: number | null): Promise<string> {
  const now = new Date();
  const today = dateId(now);
  const readable = now.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const count = (db().prepare("SELECT COUNT(*) AS n FROM coach_memories WHERE date_id = ?").get(today) as { n: number }).n;
  let id = `${today}_${count + 1}`;
  while (db().prepare("SELECT 1 FROM coach_memories WHERE id = ?").get(id)) id = `${id}x`;
  const document = `Date: ${readable}\nSummary: ${summary}`;
  db().prepare("INSERT INTO coach_memories (id, date_id, session_id, document, summary, keywords, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, today, sessionId, document, summary, keywords.join(", "), now.toISOString());
  // Both vectors; either may be filled in later if its side is down.
  await Promise.all([backfill("bge"), backfill("minilm")]);
  console.log(`[coach-memory] Session ${id} committed.`);
  return id;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length && i < b.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export interface RecalledMemory { id: string; dateId: number; document: string; similarity: number }
export interface RecallResult { memories: RecalledMemory[]; model: EmbedModel | null }

export async function recallPastAnalyses(queryText: string, daysAgo = RECALL_DAYS): Promise<RecallResult> {
  const since = dateId(new Date(Date.now() - daysAgo * 86_400_000));
  const total = (db().prepare("SELECT COUNT(*) AS n FROM coach_memories WHERE date_id >= ?").get(since) as { n: number }).n;
  if (!total) return { memories: [], model: null };

  for (const model of ["bge", "minilm"] as const) {
    if (!(await backfill(model))) continue;
    const q = await embed(model, [model === "bge" ? BGE_QUERY_PREFIX + queryText : queryText]);
    if (!q) continue;
    const rows = db().prepare(`
      SELECT m.id, m.date_id, m.document, v.vector FROM coach_memories m
      JOIN coach_memory_vectors v ON v.memory_id = m.id AND v.model = ?
      WHERE m.date_id >= ?
    `).all(model, since) as { id: string; date_id: number; document: string; vector: string }[];
    const memories = rows
      .map(r => ({ id: r.id, dateId: r.date_id, document: r.document, similarity: cosine(q[0], JSON.parse(r.vector) as number[]) }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, RECALL_N)
      .filter(m => m.similarity >= MIN_SIMILARITY[model])
      .sort((a, b) => a.dateId - b.dateId || a.id.localeCompare(b.id));
    return { memories, model };
  }
  return { memories: [], model: null };
}
