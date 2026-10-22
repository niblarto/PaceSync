import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { deleteReport, generateWeeklyReport, listReports, reportWriteState } from "@/lib/coach-weekly";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ reports: listReports(), ...reportWriteState() });
}

// "Write now" from the Coach page (no notification): starts writing in the
// background — a report can outlast the web proxy's request timeout — and
// the page polls GET until it lands.
export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (reportWriteState().writing) return NextResponse.json({ started: false, writing: true });
  void generateWeeklyReport();
  return NextResponse.json({ started: true, writing: true });
}

export async function DELETE(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  deleteReport(id);
  return NextResponse.json({ ok: true });
}
