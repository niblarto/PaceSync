import { getDb } from "@/lib/db";

const KEY = "spotify_tokens";

interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp seconds
}

export function saveTokens(tokens: StoredTokens) {
  try {
    getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
      .run(KEY, JSON.stringify(tokens));
  } catch (e) {
    console.warn("[tokenStore] Failed to save tokens:", e);
  }
}

function loadTokens(): StoredTokens | null {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(KEY) as { value_json: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.value_json) as StoredTokens;
  } catch {
    return null;
  }
}

export type TokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: "no_token_file" | "refresh_failed" | "network_error" };

export async function getFreshToken(): Promise<TokenResult> {
  const stored = loadTokens();
  if (!stored) return { ok: false, reason: "no_token_file" };

  if (Date.now() < stored.expiresAt * 1000 - 60_000) {
    return { ok: true, token: stored.accessToken };
  }

  try {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(
          `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
        ).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: stored.refreshToken,
      }),
    });
    if (!res.ok) return { ok: false, reason: "refresh_failed" };
    const data = await res.json() as { access_token: string; refresh_token?: string; expires_in: number };
    const updated: StoredTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? stored.refreshToken,
      expiresAt: Math.floor(Date.now() / 1000 + data.expires_in),
    };
    saveTokens(updated);
    return { ok: true, token: updated.accessToken };
  } catch {
    return { ok: false, reason: "network_error" };
  }
}
