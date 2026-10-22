import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { buildCoachContext } from "@/lib/coach-context";

export const dynamic = "force-dynamic";

// What the Coach sees — shown on the Coach page under "Training data".
export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(await buildCoachContext());
}
