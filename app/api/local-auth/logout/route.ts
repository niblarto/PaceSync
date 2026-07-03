import { NextResponse } from "next/server";
import { AUTH_COOKIE } from "@/lib/local-auth";

// Clears the local-auth gate cookie so the next visit requires the full
// username/password (+ 2FA) login again. Called alongside NextAuth signOut.
export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
