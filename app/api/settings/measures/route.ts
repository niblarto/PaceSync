import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { loadMeasures, saveMeasures } from "@/lib/measures-config";
import { sanitizeMeasures } from "@/lib/units";

export const dynamic = "force-dynamic";

// Recipe measures (Settings → Nutrition): { measures: { cup: { convert, metric }, … } }.
export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ measures: loadMeasures() });
}

export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null) as { measures?: unknown } | null;
  if (!body?.measures) return NextResponse.json({ error: "measures required" }, { status: 400 });
  const measures = sanitizeMeasures(body.measures);
  saveMeasures(measures);
  return NextResponse.json({ ok: true, measures });
}
