import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { LoseItAuthError } from "@/lib/loseit-gwt";
import { forgetLoseItAccount, loadLoseItAccount, loginLoseIt, verifyLoseItSession } from "@/lib/loseit-session";
import { getLoseItStatus, resetLoseItSyncState, syncLoseIt } from "@/lib/loseit-food";

export const dynamic = "force-dynamic";

// Settings → Lose It!. The password is never sent back out.
//
// GET                         → status
// POST { email, password }    → log in, save, run the first sync (history import)
// DELETE                      → forget the account (the stored diary is kept)

export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(getLoseItStatus());
}

export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: { email?: unknown; password?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password) return NextResponse.json({ error: "Email and password are required" }, { status: 400 });

  const previous = loadLoseItAccount();
  try {
    await loginLoseIt({ email, password });
    await verifyLoseItSession();
  } catch (e) {
    const status = e instanceof LoseItAuthError ? 401 : 502;
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status });
  }
  // A different account starts over with its own history import.
  if (previous && previous.email.toLowerCase() !== email.toLowerCase()) resetLoseItSyncState();

  const sync = await syncLoseIt({ force: true });
  return NextResponse.json({ ok: true, sync, ...getLoseItStatus() });
}

export async function DELETE(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  forgetLoseItAccount();
  resetLoseItSyncState();
  return NextResponse.json({ ok: true, ...getLoseItStatus() });
}
