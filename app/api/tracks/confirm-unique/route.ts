import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { markConfirmedUnique, loadConfirmedUniqueUris } from "@/lib/confirmed-unique-tracks";

// "Keep this track" in Settings' "Possible duplicates" review — marks a
// track as explicitly confirmed NOT a duplicate of whatever it was grouped
// with, so it stops being flagged in future scans. Never deletes/modifies
// the track itself — this is purely a "stop asking about this one" marker.

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ uris: Array.from(loadConfirmedUniqueUris()) });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { uri } = await req.json() as { uri?: string };
  if (!uri) return NextResponse.json({ error: "uri required" }, { status: 400 });
  markConfirmedUnique(uri);
  return NextResponse.json({ ok: true });
}
