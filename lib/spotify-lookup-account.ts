import { getDb } from "@/lib/db";
import { getFreshToken } from "@/lib/tokenStore";

// A SECONDARY Spotify account, signed in on the read-only lookup app (SPOTIFY_CLIENT_ID_2 /
// SPOTIFY_CLIENT_SECRET_2), used for LOOKUPS that need a user login - e.g. reading an album or
// playlist, checking tracks still exist - so those never use the main account or the main app. It is
// never used to write anything: the sign-in asks for no write permissions.
//
// Register this redirect URI on the lookup app in the Spotify developer dashboard (and, while that app
// is in development mode, add the secondary account under User Management):
//   <NEXTAUTH_URL>/api/spotify-app2/callback

const KEY = "spotify_lookup_account_tokens";
const CREDS_KEY = "spotify_lookup_app_credentials";

// The lookup app's client id / secret: whatever was entered in Settings (stored on the server), else
// the SPOTIFY_CLIENT_ID_2 / SPOTIFY_CLIENT_SECRET_2 pair from .env.local. One app serves both the
// search lookups (its own credentials, no login) and the secondary account's sign-in.
export function lookupCredentials(): { id: string; secret: string; source: "settings" | "env" } | null {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(CREDS_KEY) as { value_json: string } | undefined;
    if (row) {
      const c = JSON.parse(row.value_json) as { clientId?: string; clientSecret?: string };
      if (c.clientId && c.clientSecret) return { id: c.clientId, secret: c.clientSecret, source: "settings" };
    }
  } catch { /* fall through */ }
  const id = process.env.SPOTIFY_CLIENT_ID_2;
  const secret = process.env.SPOTIFY_CLIENT_SECRET_2;
  return id && secret ? { id, secret, source: "env" } : null;
}

// Saves new credentials. A different app means the stored sign-in no longer applies, so it is cleared.
export function saveLookupCredentials(clientId: string, clientSecret: string): void {
  const prev = lookupCredentials();
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(CREDS_KEY, JSON.stringify({ clientId: clientId.trim(), clientSecret: clientSecret.trim() }));
  if (prev?.id !== clientId.trim()) lookupAccountDisconnect();
}

// Forgets the credentials entered in Settings (falls back to .env.local, if set there).
export function clearLookupCredentials(): void {
  try { getDb().prepare("DELETE FROM kv_config WHERE key = ?").run(CREDS_KEY); } catch { /* ignore */ }
  lookupAccountDisconnect();
}

interface StoredTokens { accessToken: string; refreshToken: string; expiresAt: number; accountId?: string } // expiresAt: unix seconds

export function lookupAppConfigured(): boolean {
  return !!lookupCredentials();
}

export function lookupRedirectUri(): string {
  return `${(process.env.NEXTAUTH_URL ?? "").replace(/\/$/, "")}/api/spotify-app2/callback`;
}

function load(): StoredTokens | null {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(KEY) as { value_json: string } | undefined;
    return row ? (JSON.parse(row.value_json) as StoredTokens) : null;
  } catch { return null; }
}

function save(t: StoredTokens): void {
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(KEY, JSON.stringify(t));
}

export function lookupAccountConnected(): boolean {
  return lookupAppConfigured() && !!load();
}

export function lookupAuthorizeUrl(state: string): string {
  const q = new URLSearchParams({
    client_id: lookupCredentials()?.id ?? "",
    response_type: "code",
    redirect_uri: lookupRedirectUri(),
    state,
    show_dialog: "true", // always ask which account: sign in with the SECONDARY one
  });
  // No scope on purpose: read-only lookups of public data need none, and nothing here may write.
  return `https://accounts.spotify.com/authorize?${q}`;
}

function basicAuth(): string {
  const c = lookupCredentials();
  return `Basic ${Buffer.from(`${c?.id ?? ""}:${c?.secret ?? ""}`).toString("base64")}`;
}

export async function lookupExchangeCode(code: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!lookupAppConfigured()) return { ok: false, error: "the lookup app's client id and secret are not set" };
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuth() },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: lookupRedirectUri() }),
  }).catch(() => null);
  if (!res?.ok) return { ok: false, error: `Spotify refused the code (${res?.status ?? "no response"})` };
  const d = await res.json() as { access_token: string; refresh_token?: string; expires_in: number };
  if (!d.refresh_token) return { ok: false, error: "Spotify sent no refresh token" };
  // One request to remember WHICH account signed in (shown on the Status tab).
  let accountId: string | undefined;
  try {
    const me = await fetch("https://api.spotify.com/v1/me", { headers: { Authorization: `Bearer ${d.access_token}` }, signal: AbortSignal.timeout(10000) });
    if (me.ok) accountId = ((await me.json()) as { id?: string }).id;
  } catch { /* cosmetic */ }
  save({ accessToken: d.access_token, refreshToken: d.refresh_token, expiresAt: Math.floor(Date.now() / 1000 + d.expires_in), accountId });
  return { ok: true };
}

async function lookupAccountToken(): Promise<string | null> {
  if (!lookupAppConfigured()) return null;
  const stored = load();
  if (!stored) return null;
  if (Date.now() < stored.expiresAt * 1000 - 60_000) return stored.accessToken;
  try {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuth() },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: stored.refreshToken }),
    });
    if (!res.ok) return null;
    const d = await res.json() as { access_token: string; refresh_token?: string; expires_in: number };
    const updated: StoredTokens = {
      accessToken: d.access_token,
      refreshToken: d.refresh_token ?? stored.refreshToken,
      expiresAt: Math.floor(Date.now() / 1000 + d.expires_in),
      accountId: stored.accountId,
    };
    save(updated);
    return updated.accessToken;
  } catch { return null; }
}

// For the Status tab.
export function lookupAccountSummary(): { configured: boolean; clientIdHint: string | null; credentialsSource: "settings" | "env" | null; connected: boolean; accountId: string | null; tokenLeftMs: number } {
  const c = lookupCredentials();
  const t = load();
  return {
    configured: !!c,
    clientIdHint: c ? `${c.id.slice(0, 4)}…${c.id.slice(-4)}` : null,
    credentialsSource: c?.source ?? null,
    connected: !!c && !!t,
    accountId: t?.accountId ?? null,
    tokenLeftMs: t ? t.expiresAt * 1000 - Date.now() : 0,
  };
}

export function lookupAccountDisconnect(): void {
  try { getDb().prepare("DELETE FROM kv_config WHERE key = ?").run(KEY); } catch { /* ignore */ }
}

export type LookupToken =
  | { ok: true; token: string; source: "lookup-account" | "main" }
  | { ok: false; reason: string };

// The login to use for a LOOKUP that needs one. With the lookup app configured this is only ever the
// secondary account's login - never the main account or main app. Only if no lookup app is configured
// at all does it use the main login (there is nothing else).
export async function getLookupToken(): Promise<LookupToken> {
  if (lookupAppConfigured()) {
    const t = await lookupAccountToken();
    return t ? { ok: true, token: t, source: "lookup-account" } : { ok: false, reason: "the secondary lookup account isn't connected (Settings > Integrations)" };
  }
  const main = await getFreshToken();
  return main.ok ? { ok: true, token: main.token, source: "main" } : { ok: false, reason: `no Spotify login on the server (${main.reason})` };
}
