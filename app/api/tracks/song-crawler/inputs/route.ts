import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { loadCrawlerInputs, saveCrawlerInputs } from "@/lib/crawler-inputs";

// The Song Crawler form's saved settings, shared by every browser (and used by the Genre
// explorer's Lookup). GET -> { inputs } (null if never saved); POST { ...fields } merges and saves.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ inputs: loadCrawlerInputs() });
}

export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  return NextResponse.json({ inputs: saveCrawlerInputs(body) });
}
