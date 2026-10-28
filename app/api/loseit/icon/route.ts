import { NextRequest } from "next/server";
import * as fs from "node:fs";
import * as path from "node:path";
import { LOSEIT_ICON_BASE, LOSEIT_ICONS } from "@/lib/loseit-icons";

// GET /api/loseit/icon?name=WhiteBread → the Lose It! food icon (29×29 PNG).
// Same idea as /api/itunes-art: fetched from Lose It!'s CDN the first time,
// then served from cache/loseit-icons/ on disk. Unknown names get the
// "Default" icon, so every food shows something.

const CACHE_DIR = path.join(process.cwd(), "cache", "loseit-icons");
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}

const HEADERS = { "Content-Type": "image/png", "Cache-Control": "public, max-age=2592000, immutable" };

export async function GET(req: NextRequest) {
  const asked = req.nextUrl.searchParams.get("name") ?? "";
  // Only names in the map are fetched, so the URL can't be steered anywhere else.
  const name = LOSEIT_ICONS[asked] ? asked : "Default";
  const file = path.join(CACHE_DIR, `${name}.png`);
  if (fs.existsSync(file)) return new Response(new Uint8Array(fs.readFileSync(file)), { headers: HEADERS });

  try {
    const res = await fetch(`${LOSEIT_ICON_BASE}${LOSEIT_ICONS[name]}.cache.png`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return new Response(null, { status: 404 });
    const buf = Buffer.from(await res.arrayBuffer());
    try { fs.writeFileSync(file, buf); } catch {}
    return new Response(new Uint8Array(buf), { headers: HEADERS });
  } catch {
    return new Response(null, { status: 404 });
  }
}
