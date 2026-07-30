import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getMixCandidates } from "@/lib/mix-candidates";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const date = req.nextUrl.searchParams.get("date") ?? "";
  const title = req.nextUrl.searchParams.get("title") ?? "";
  if (!DATE_RE.test(date) || !title) {
    return NextResponse.json({ error: "date (YYYY-MM-DD) and title required" }, { status: 400 });
  }
  const entry = getMixCandidates(date, title);
  return NextResponse.json({ segments: entry?.segments ?? [] });
}
