import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { buildStatusReport } from "@/lib/system-status";

// Settings > Status: the state of accounts and restrictions, what is queued, and the health of the server
// and external services. ?live=0 skips the (slower) checks of external services.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const live = req.nextUrl.searchParams.get("live") !== "0";
  return NextResponse.json(await buildStatusReport(live));
}
