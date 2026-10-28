import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { getFavouriteUris, setFavourite } from "@/lib/favourite-tracks";

// GET -> { uris: string[] }   POST { uri, favourite: boolean } -> { uris }
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ uris: getFavouriteUris() });
}

export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { uri, favourite } = await req.json().catch(() => ({})) as { uri?: string; favourite?: boolean };
  if (typeof uri !== "string" || !/^spotify:track:[A-Za-z0-9]{22}$/.test(uri) || typeof favourite !== "boolean") {
    return NextResponse.json({ error: "uri (spotify:track:…) and favourite (boolean) required" }, { status: 400 });
  }
  return NextResponse.json({ uris: setFavourite(uri, favourite) });
}
