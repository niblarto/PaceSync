import { getDb } from "@/lib/db";
import { LoseItAuthError, pingLoseIt, type GwtIdentity } from "@/lib/loseit-gwt";

// Lose It! account + web session. The password is kept (Settings → Lose It!)
// so the server can log itself back in whenever the session lapses — the
// login cookies (liauth / fn_auth, a JWT) last 14 days. Login is the
// endpoint the mobile apps use: POST api.loseit.com/account/login with a
// password grant, which answers with the cookies plus { user_id, username }.

const ACCOUNT_KEY = "loseit_account";
const SESSION_KEY = "loseit_session";
const RENEW_BEFORE_MS = 2 * 86_400_000; // re-login when < 2 days of the 14 remain

export interface LoseItAccount { email: string; password: string }

export interface LoseItSession {
  cookies: Record<string, string>;
  userId: number;
  username: string;
  loggedInAt: string;
  expiresAt: string | null;
}

function kvGet<T>(key: string): T | null {
  try {
    const row = getDb().prepare("SELECT value_json FROM kv_config WHERE key = ?").get(key) as { value_json: string } | undefined;
    if (row) return JSON.parse(row.value_json) as T;
  } catch {}
  return null;
}

function kvSet(key: string, value: unknown): void {
  getDb().prepare("INSERT INTO kv_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(key, JSON.stringify(value));
}

function kvDelete(key: string): void {
  getDb().prepare("DELETE FROM kv_config WHERE key = ?").run(key);
}

export function loadLoseItAccount(): LoseItAccount | null {
  const a = kvGet<LoseItAccount>(ACCOUNT_KEY);
  return a && a.email && a.password ? a : null;
}

export function loadLoseItSession(): LoseItSession | null {
  return kvGet<LoseItSession>(SESSION_KEY);
}

export function forgetLoseItAccount(): void {
  kvDelete(ACCOUNT_KEY);
  kvDelete(SESSION_KEY);
}

// Logs in with the given credentials. Throws on bad credentials so the
// Settings form can show the error; only saves anything on success.
export async function loginLoseIt(account: LoseItAccount): Promise<LoseItSession> {
  const res = await fetch("https://api.loseit.com/account/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ username: account.email, password: account.password, grant_type: "password" }),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    throw new LoseItAuthError("Lose It! rejected the email or password");
  }
  if (!res.ok) throw new Error(`Lose It! login failed: HTTP ${res.status}`);
  const body = await res.json() as { user_id?: number; username?: string };
  if (typeof body.user_id !== "number") throw new Error("Lose It! login returned no user id");

  const cookies: Record<string, string> = {};
  let maxAgeSec: number | null = null;
  const setCookies = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  for (const c of setCookies) {
    const m = c.match(/^([^=]+)=([^;]*)/);
    if (!m) continue;
    cookies[m[1]] = m[2];
    if (m[1] === "liauth") {
      const age = c.match(/Max-Age=(\d+)/i);
      if (age) maxAgeSec = Number(age[1]);
    }
  }
  if (!cookies.liauth) throw new Error("Lose It! login returned no session cookie");

  const now = Date.now();
  const session: LoseItSession = {
    cookies,
    userId: body.user_id,
    username: body.username ?? account.email,
    loggedInAt: new Date(now).toISOString(),
    expiresAt: maxAgeSec ? new Date(now + maxAgeSec * 1000).toISOString() : null,
  };
  kvSet(ACCOUNT_KEY, account);
  kvSet(SESSION_KEY, session);
  return session;
}

function identityOf(s: LoseItSession): GwtIdentity {
  // Cloudflare's short-lived bot cookies aren't needed; only the auth ones are.
  const cookie = Object.entries(s.cookies)
    .filter(([k]) => !k.startsWith("__cf") && !k.startsWith("_cf"))
    .map(([k, v]) => `${k}=${v}`).join("; ");
  return { cookie, userId: s.userId, username: s.username };
}

// The current session, logging in again first if there isn't one or it's
// about to expire. Throws LoseItAuthError when no account is configured.
export async function getLoseItIdentity(forceLogin = false): Promise<GwtIdentity> {
  const account = loadLoseItAccount();
  if (!account) throw new LoseItAuthError("Lose It! account not connected");
  let session = loadLoseItSession();
  const expiring = !session?.expiresAt || Date.parse(session.expiresAt) - Date.now() < RENEW_BEFORE_MS;
  if (forceLogin || !session || expiring) session = await loginLoseIt(account);
  return identityOf(session);
}

// Runs fn with a session; if Lose It! says the session is no longer valid
// (logged out elsewhere, password changed), logs in once more and retries.
export async function withLoseItSession<T>(fn: (who: GwtIdentity) => Promise<T>): Promise<T> {
  const who = await getLoseItIdentity();
  try {
    return await fn(who);
  } catch (e) {
    if (!(e instanceof LoseItAuthError)) throw e;
    return fn(await getLoseItIdentity(true));
  }
}

// Used by Settings after connecting: proves the session works for RPC too.
export async function verifyLoseItSession(): Promise<void> {
  await withLoseItSession(pingLoseIt);
}
