import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

function formatAirDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  } catch {
    return "";
  }
}

interface EpPeer {
  type: string;
  pid: string;
  title: string;
  first_broadcast_date?: string;
}

interface ProgInfo {
  type?: string;
  pid?: string;
  first_broadcast_date?: string;
  peers?: { previous?: EpPeer; next?: EpPeer };
  parent?: { programme?: { type?: string; pid?: string; title?: string } };
}

async function fetchProgInfo(pid: string): Promise<ProgInfo | null> {
  try {
    const res = await fetch(`https://www.bbc.co.uk/programmes/${pid}.json`, {
      headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { programme?: ProgInfo };
    return data?.programme ?? null;
  } catch {
    return null;
  }
}

// For brand PIDs: find the most recent past episode via the episodes list.
async function latestPastFromBrand(brandPid: string): Promise<{ pid: string; airDate: string | null }> {
  try {
    const res = await fetch(`https://www.bbc.co.uk/programmes/${brandPid}/episodes.json?limit=5`, {
      headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json() as { episodes?: { elements?: { pid?: unknown; first_broadcast_date?: unknown }[] } };
      const elements = data?.episodes?.elements ?? [];
      const now = new Date();
      let fallback: { pid: string; airDate: string | null } | null = null;
      for (const ep of elements) {
        const pid = ep?.pid;
        const rawDate = ep?.first_broadcast_date;
        if (typeof pid !== "string" || pid === brandPid) continue;
        const airDate = typeof rawDate === "string" ? formatAirDate(rawDate) : null;
        if (!fallback) fallback = { pid, airDate };
        const epDate = typeof rawDate === "string" ? new Date(rawDate) : null;
        if (epDate && epDate <= now) return { pid, airDate };
      }
      if (fallback) return fallback;
    }
  } catch { /* fall through */ }
  return { pid: brandPid, airDate: null };
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const pid = req.nextUrl.searchParams.get("pid");
  if (!pid) return NextResponse.json({ error: "Missing pid" }, { status: 400 });

  const info = await fetchProgInfo(pid);

  if (info?.type === "episode") {
    // An episode PID only identifies one broadcast forever — findLatestEpisode
    // (bbc/tracks) treats whatever pid a card is saved with as if it were the
    // *brand*, and scrapes that PID's /episodes/player page for the latest
    // episode. For a real episode PID that page can list unrelated/future
    // episodes, which breaks segment lookup once the saved episode airs and
    // scrolls out of the schedule. Surface the true brand pid/title so
    // callers (BbcBrowserCard) can persist that instead of the episode pid.
    const brandPid = info.parent?.programme?.type === "brand" ? info.parent.programme.pid : undefined;
    const brandTitle = info.parent?.programme?.type === "brand" ? info.parent.programme.title : undefined;

    const now = new Date();
    const broadcastDate = info.first_broadcast_date;
    const epDate = broadcastDate ? new Date(broadcastDate) : null;

    if (epDate && epDate <= now) {
      // Already aired — use this episode directly
      return NextResponse.json({
        episodePid: pid,
        airDate: formatAirDate(broadcastDate!),
        brandPid, brandTitle,
      });
    }

    // Episode is upcoming — use the previous episode if available
    const prev = info.peers?.previous;
    if (prev?.pid) {
      return NextResponse.json({
        episodePid: prev.pid,
        airDate: prev.first_broadcast_date ? formatAirDate(prev.first_broadcast_date) : null,
        brandPid, brandTitle,
      });
    }

    // No previous episode, fall back to showing this (future) episode
    return NextResponse.json({
      episodePid: pid,
      airDate: broadcastDate ? formatAirDate(broadcastDate) : null,
      brandPid, brandTitle,
    });
  }

  // Brand PID (or unknown): find the most recent past episode
  const { pid: episodePid, airDate } = await latestPastFromBrand(pid);
  return NextResponse.json({ episodePid, airDate });
}
