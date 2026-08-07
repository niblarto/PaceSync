import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadBpmOverrides, saveBpmOverrides, RUN_KINDS, type BpmOverrides, type RunKind } from "@/lib/bpm-overrides";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ overrides: loadBpmOverrides() });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { overrides } = await req.json() as { overrides?: Record<string, { min?: unknown; max?: unknown; sweet?: unknown }> };
  const clean: BpmOverrides = {};
  for (let i = 0; i < RUN_KINDS.length; i++) {
    const kind: RunKind = RUN_KINDS[i];
    const o = overrides?.[kind];
    if (!o) continue;
    const min = Number(o.min);
    const max = Number(o.max);
    const sweet = Number(o.sweet);
    const entry: { min?: number; max?: number; sweet?: number } = {};
    if (Number.isFinite(min) && min > 0) entry.min = min;
    if (Number.isFinite(max) && max > 0) entry.max = max;
    if (Number.isFinite(sweet) && sweet > 0) entry.sweet = sweet;
    if (entry.min !== undefined && entry.max !== undefined && entry.min > entry.max) {
      return NextResponse.json({ error: `${kind}: min BPM is above max` }, { status: 400 });
    }
    if (entry.sweet !== undefined && entry.min !== undefined && entry.sweet < entry.min) {
      return NextResponse.json({ error: `${kind}: sweet spot BPM is below min` }, { status: 400 });
    }
    if (entry.sweet !== undefined && entry.max !== undefined && entry.sweet > entry.max) {
      return NextResponse.json({ error: `${kind}: sweet spot BPM is above max` }, { status: 400 });
    }
    if (entry.min !== undefined || entry.max !== undefined || entry.sweet !== undefined) clean[kind] = entry;
  }
  saveBpmOverrides(clean);
  return NextResponse.json({ ok: true, overrides: clean });
}
