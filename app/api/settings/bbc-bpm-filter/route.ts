import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getBbcBpmFilterEnabled, setBbcBpmFilterEnabled } from "@/lib/bbc-bpm-filter-config";

export async function GET() {
  return NextResponse.json({ enabled: getBbcBpmFilterEnabled() });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as { enabled?: boolean };
  setBbcBpmFilterEnabled(!!body.enabled);
  return NextResponse.json({ ok: true, enabled: !!body.enabled });
}
