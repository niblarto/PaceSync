import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getCsvStatus } from "@/lib/csv-heal";

// Read-only column-blank snapshot for the active playlist's CSV — same
// data /api/settings/heal-now returns inline when the sweep is triggered,
// but fetchable independently so the Settings page can show it on mount
// (surviving a reload) and refresh it once a running sweep finishes.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const status = await getCsvStatus().catch(() => null);
  return NextResponse.json({ status });
}
