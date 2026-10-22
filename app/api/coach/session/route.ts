import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { getOpenSessionId } from "@/lib/coach-store";
import { closeSession } from "@/lib/coach-session";

// "New conversation": closes the open session; it's summarised into
// coaching memory in the background.
export async function DELETE(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = getOpenSessionId();
  if (id != null) closeSession(id);
  return NextResponse.json({ ok: true });
}
