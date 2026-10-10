import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { hasApiAccess } from "@/lib/mobile-auth";
import { loadFcmToken, saveFcmToken } from "@/lib/fcm-config";

// GET — Settings UI's "registered" indicator, session-gated like any other
// web-facing settings read.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ token: loadFcmToken() });
}

// POST — the Android app itself calls this (with its bearer token, no
// browser session) right after it obtains a Firebase device token, so
// hasApiAccess (not a plain session check) is required here.
export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { fcmToken } = await req.json() as { fcmToken?: string };
  if (!fcmToken) return NextResponse.json({ error: "fcmToken required" }, { status: 400 });
  saveFcmToken(fcmToken);
  return NextResponse.json({ ok: true });
}
