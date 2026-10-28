import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { getLoseItStatus, syncLoseIt } from "@/lib/loseit-food";

export const dynamic = "force-dynamic";

// POST {}             → re-read today (and yesterday on a new day) now, skipping the throttle
// POST { full: true } → also re-download the full export (~1.6 MB) and rebuild all history
export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: { full?: unknown } = {};
  try { body = await req.json(); } catch {}
  const sync = await syncLoseIt({ force: true, full: body.full === true });
  return NextResponse.json({ sync, ...getLoseItStatus() }, { status: sync.status === "error" ? 502 : 200 });
}
