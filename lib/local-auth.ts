import crypto from "crypto";
import fs from "fs";
import path from "path";
import { SignJWT, jwtVerify } from "jose";

// Local username/password + TOTP gate that sits in front of the Spotify
// OAuth flow. Credentials live in local-auth.json (gitignored, uploaded by
// deploy.py like .env.local). Passwords are scrypt-hashed; the TOTP secret
// is standard RFC 6238 (SHA1/6 digits/30s) so LastPass Authenticator,
// Google Authenticator etc. all work.

const FILE = path.join(process.cwd(), "local-auth.json");

export const AUTH_COOKIE = "pacesync_auth";
export const AUTH_MAX_AGE_SEC = 30 * 24 * 60 * 60; // 30 days

export interface LocalAuthConfig {
  username: string;
  // scrypt hash: salt and derived key, both hex
  salt: string;
  hash: string;
  totpSecret?: string;   // base32 — present once a QR has been generated
  totpEnabled?: boolean; // true once the user has confirmed a code
}

export function loadLocalAuth(): LocalAuthConfig | null {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf-8")) as LocalAuthConfig;
    if (data?.username && data?.salt && data?.hash) return data;
  } catch {}
  return null;
}

export function saveLocalAuth(config: LocalAuthConfig): void {
  fs.writeFileSync(FILE, JSON.stringify(config, null, 2), "utf-8");
}

// ── Password ────────────────────────────────────────────────────────────────

export function hashPassword(password: string, saltHex?: string): { salt: string; hash: string } {
  const salt = saltHex ? Buffer.from(saltHex, "hex") : crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return { salt: salt.toString("hex"), hash: hash.toString("hex") };
}

export function verifyPassword(password: string, config: LocalAuthConfig): boolean {
  const { hash } = hashPassword(password, config.salt);
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(config.hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── TOTP (RFC 6238, SHA1, 6 digits, 30s period) ─────────────────────────────

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateTotpSecret(): string {
  const bytes = crypto.randomBytes(20);
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  const cleaned = s.replace(/=+$/, "").toUpperCase();
  for (let i = 0; i < cleaned.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(cleaned[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totpCode(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(bin % 1_000_000).padStart(6, "0");
}

/** Accepts the current 30s window ±1 to absorb clock drift. */
export function verifyTotp(secret: string, code: string): boolean {
  const cleaned = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(cleaned)) return false;
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (const c of [counter - 1, counter, counter + 1]) {
    const expected = totpCode(secret, c);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(cleaned))) return true;
  }
  return false;
}

export function otpauthUrl(config: LocalAuthConfig): string {
  return (
    `otpauth://totp/PaceSync:${encodeURIComponent(config.username)}` +
    `?secret=${config.totpSecret}&issuer=PaceSync&algorithm=SHA1&digits=6&period=30`
  );
}

// ── Signed cookie token (verified in edge middleware via jose) ──────────────

function jwtSecret(): Uint8Array {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("NEXTAUTH_SECRET not set");
  return new TextEncoder().encode(secret);
}

export async function createAuthToken(username: string): Promise<string> {
  return new SignJWT({ u: username, scope: "local-auth" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${AUTH_MAX_AGE_SEC}s`)
    .sign(jwtSecret());
}

export async function verifyAuthToken(token: string): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(token, jwtSecret());
    return payload.scope === "local-auth";
  } catch {
    return false;
  }
}
