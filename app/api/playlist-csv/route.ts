import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readFile } from "fs/promises";
import { activeCsvPath } from "@/lib/running-playlist-config";

// Serves the active playlist's library CSV. This must be an API route, not a
// static /public fetch: Next.js only serves public/ files that existed at
// build time, so CSVs created at runtime (new playlist imports) would 404.
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return new Response("Unauthorized", { status: 401 });
  try {
    const csv = await readFile(activeCsvPath(), "utf8");
    return new Response(csv, {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch {
    return new Response("No library CSV for the active playlist", { status: 404 });
  }
}
