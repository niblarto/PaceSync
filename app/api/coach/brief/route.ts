import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { briefStatus, briefWriteState, ensureBrief } from "@/lib/coach-brief";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// The "next two weeks" panel on the Runna Schedule card. GET returns the plan
// facts (worked out by the app), the AI's saved sentence, whether that needs
// rewriting, and whether one is being written (or waiting for the AI). POST asks
// for a new sentence: {force: true} always (the Refresh button), otherwise only
// if it is stale. It starts in the background (it can outlast a web request on
// the local model) and the page polls GET.
export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { facts, brief, stale } = await briefStatus();
  return NextResponse.json({ facts: facts?.lines ?? null, brief, stale, ...briefWriteState() });
}

export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({})) as { force?: boolean };
  const result = await ensureBrief({ force: body.force === true });
  return NextResponse.json({ ...result, ...briefWriteState() });
}
