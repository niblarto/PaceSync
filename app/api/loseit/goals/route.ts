import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { getLoseItGoals } from "@/lib/loseit-food";

export const dynamic = "force-dynamic";

// The goal set in Lose It!: goal weight, projected goal date, plan. Kept for an
// hour server-side; ?refresh=1 reads it again.
export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await getLoseItGoals(req.nextUrl.searchParams.get("refresh") === "1"));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
