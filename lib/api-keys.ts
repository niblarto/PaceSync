import crypto from "crypto";
import { getDb } from "@/lib/db";

// API keys for external, read-only callers (the /api/v1 endpoints; e.g. the "muse" assistant). A key is shown once when it
// is created; only its SHA-256 is stored. Revoking takes effect on the next request.

export interface ApiKeyInfo { id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export function createApiKey(name: string): { key: string; info: ApiKeyInfo } {
  const key = `psk_${crypto.randomBytes(30).toString("base64url")}`;
  const info: ApiKeyInfo = { id: crypto.randomUUID(), name: name.trim().slice(0, 60) || "API key", prefix: key.slice(0, 8), createdAt: new Date().toISOString(), lastUsedAt: null, revokedAt: null };
  getDb().prepare("INSERT INTO api_keys (id, name, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(info.id, info.name, info.prefix, sha(key), info.createdAt);
  return { key, info };
}

export function listApiKeys(): ApiKeyInfo[] {
  const rows = getDb().prepare("SELECT id, name, prefix, created_at, last_used_at, revoked_at FROM api_keys ORDER BY created_at DESC").all() as
    { id: string; name: string; prefix: string; created_at: string; last_used_at: string | null; revoked_at: string | null }[];
  return rows.map(r => ({ id: r.id, name: r.name, prefix: r.prefix, createdAt: r.created_at, lastUsedAt: r.last_used_at, revokedAt: r.revoked_at }));
}

export function revokeApiKey(id: string): boolean {
  return getDb().prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(new Date().toISOString(), id).changes > 0;
}

// The key sent as `Authorization: Bearer psk_…` or `X-API-Key`; returns the stored key's id/name when it is valid and not revoked.
export function verifyApiKey(headers: Headers): { id: string; name: string } | null {
  const auth = headers.get("authorization") ?? "";
  const key = (auth.startsWith("Bearer ") ? auth.slice(7) : headers.get("x-api-key") ?? "").trim();
  if (!key.startsWith("psk_") || key.length > 100) return null;
  const row = getDb().prepare("SELECT id, name FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL").get(sha(key)) as { id: string; name: string } | undefined;
  if (!row) return null;
  getDb().prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
  return row;
}

// 60 requests a minute per key (a sliding window held in memory; a restart just resets it).
const WINDOW_MS = 60_000, LIMIT = 60;
const hits = new Map<string, number[]>();
export function rateLimit(keyId: string): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  const recent = (hits.get(keyId) ?? []).filter(t => now - t < WINDOW_MS);
  if (recent.length >= LIMIT) { hits.set(keyId, recent); return { ok: false, retryAfterSec: Math.max(1, Math.ceil((WINDOW_MS - (now - recent[0])) / 1000)) }; }
  recent.push(now);
  hits.set(keyId, recent);
  return { ok: true, retryAfterSec: 0 };
}

let lastTrim = 0;
export function logApiRequest(keyId: string, path: string, status: number, ms: number): void {
  try {
    const db = getDb();
    db.prepare("INSERT INTO api_request_log (at, key_id, path, status, ms) VALUES (?, ?, ?, ?, ?)").run(new Date().toISOString(), keyId, path.slice(0, 200), status, Math.round(ms));
    if (Date.now() - lastTrim > 3_600_000) {
      lastTrim = Date.now();
      db.prepare("DELETE FROM api_request_log WHERE at < ?").run(new Date(Date.now() - 30 * 86_400_000).toISOString());
    }
  } catch { /* logging must never break a request */ }
}

export function recentApiRequests(limit = 40): { at: string; keyName: string; path: string; status: number; ms: number }[] {
  const rows = getDb().prepare(
    "SELECT l.at, COALESCE(k.name, '(deleted)') AS keyName, l.path, l.status, l.ms FROM api_request_log l LEFT JOIN api_keys k ON k.id = l.key_id ORDER BY l.id DESC LIMIT ?",
  ).all(limit) as { at: string; keyName: string; path: string; status: number; ms: number }[];
  return rows;
}
