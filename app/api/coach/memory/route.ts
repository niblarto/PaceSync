import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { deleteMemory, listMemories } from "@/lib/coach-memory";
import { isSummarising } from "@/lib/coach-session";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ memories: listMemories(), summarising: isSummarising() });
}

export async function DELETE(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  deleteMemory(id);
  return NextResponse.json({ ok: true });
}
