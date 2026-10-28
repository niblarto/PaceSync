import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { getBackupState, runBackupNow, saveBackupSettings } from "@/lib/backup-settings";

export const dynamic = "force-dynamic";

// Settings → Backup. The share password is never sent back out.
//
// GET                    → schedule, share, last run
// PUT  { …, password? }  → save (an empty/missing password keeps the stored one)
// POST                   → run a backup now

export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(getBackupState());
}

export async function PUT(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : undefined);
  try {
    return NextResponse.json(saveBackupSettings({
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      time: str("time"),
      keepDays: typeof body.keepDays === "number" ? body.keepDays : undefined,
      host: str("host"), share: str("share"), folder: str("folder"),
      username: str("username"), password: str("password"),
    }));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(runBackupNow());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 409 });
  }
}
