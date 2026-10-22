import { getDb } from "@/lib/db";

// Garmin Connect Personal API — Garmin's official read-only access to the
// user's own data (https://developer.garmin.com/gc-developer-program/personal/).
// A key made in Garmin Connect Web (valid up to a year, shown once) is
// exchanged for a 24h access token; there are no refresh tokens, so a new
// token is simply requested from the key when the old one expires.
// Supplements GarminDB (which has no HRV and imports laps empty); GarminDB
// stays the main store.

const BASE = "https://personal.connectapi.garmin.com";
const TOKEN_URL = `${BASE}/personalapitoken-service/personal-api/personal-api-key/token`;
const KEY = "garmin_personal_api";

interface Stored {
  apiKey: string;
  savedAt: string;
  token?: string;
  tokenExpiresAt?: number; // ms epoch
}

function load(): Stored | null {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(KEY) as { value_json: string } | undefined;
    const d = row ? JSON.parse(row.value_json) as Stored : null;
    return d?.apiKey ? d : null;
  } catch {
    return null;
  }
}

function store(d: Stored): void {
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(KEY, JSON.stringify(d));
}

export function garminApiStatus(): { configured: boolean; savedAt: string | null; tokenValidUntil: string | null } {
  const d = load();
  return {
    configured: !!d,
    savedAt: d?.savedAt ?? null,
    tokenValidUntil: d?.token && d.tokenExpiresAt && d.tokenExpiresAt > Date.now() ? new Date(d.tokenExpiresAt).toISOString() : null,
  };
}

export function saveGarminApiKey(apiKey: string): void {
  store({ apiKey: apiKey.trim(), savedAt: new Date().toISOString() });
}

export function deleteGarminApiKey(): void {
  getDb().prepare("DELETE FROM kv_config WHERE key = ?").run(KEY);
}

export class GarminApiError extends Error {
  constructor(message: string, public status?: number) { super(message); }
}

async function fetchToken(d: Stored): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    // The token comes back as plain text — asking for JSON gets a 406.
    headers: { Authorization: `ApiKey ${d.apiKey}`, Accept: "*/*" },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new GarminApiError(
      res.status === 401 || res.status === 403
        ? "Garmin rejected the API key — it may have expired or been deleted. Create a new one in Garmin Connect."
        : `Garmin token request failed (${res.status}): ${text.slice(0, 200)}`,
      res.status,
    );
  }
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text) as Record<string, unknown>; } catch {}
  const token = (body.access_token ?? body.accessToken ?? body.token ?? (text && !text.trim().startsWith("{") ? text.trim() : undefined)) as string | undefined;
  if (!token) throw new GarminApiError("Garmin's token response had no access token");
  // Expiry: the JWT's own "exp" claim, else expires_in, else 24h. Renewed
  // 10 minutes early.
  let expiresAt = Date.now() + 24 * 3600_000;
  const expiresIn = Number(body.expires_in ?? body.expiresIn ?? 0);
  if (expiresIn > 0) expiresAt = Date.now() + expiresIn * 1000;
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()) as { exp?: number };
    if (claims.exp) expiresAt = claims.exp * 1000;
  } catch {}
  store({ ...d, token, tokenExpiresAt: expiresAt - 10 * 60_000 });
  return token;
}

async function accessToken(forceNew = false): Promise<string> {
  const d = load();
  if (!d) throw new GarminApiError("No Garmin Personal API key saved (Settings → Integrations)");
  if (!forceNew && d.token && d.tokenExpiresAt && d.tokenExpiresAt > Date.now()) return d.token;
  return fetchToken(d);
}

async function request(path: string, accept = "application/json"): Promise<Response> {
  let token = await accessToken();
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: accept },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401 && attempt === 0) {
      token = await accessToken(true);
      continue;
    }
    if (!res.ok) throw new GarminApiError(`Garmin API ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status);
    return res;
  }
  throw new GarminApiError("Garmin API authorisation failed");
}

export async function garminApiGet<T = unknown>(path: string): Promise<T> {
  const res = await request(path);
  return await res.json() as T;
}

// Original activity file (zip containing the FIT).
export async function garminApiDownloadActivity(activityId: string | number): Promise<ArrayBuffer> {
  const res = await request(`/download-service/files/activity/${activityId}`, "application/x-zip-compressed, application/octet-stream, */*");
  return res.arrayBuffer();
}
