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
    // An episode PID only identifies one broadcast forever — a saved card's
    // pid can be an episode that's since been superseded by newer ones
    // (e.g. a weekly show airs again next week). Walk forward via
    // peers.next until hitting a future/unaired episode or running out of
    // next links, landing on the true latest AIRED episode rather than just
    // whichever one happened to be saved. Surface the true brand pid/title
    // so callers (BbcBrowserCard) can persist that instead of the episode pid.
    const brandPid = info.parent?.programme?.type === "brand" ? info.parent.programme.pid : undefined;
    const brandTitle = info.parent?.programme?.type === "brand" ? info.parent.programme.title : undefined;

    const now = new Date();
    const broadcastDate = info.first_broadcast_date;
    const epDate = broadcastDate ? new Date(broadcastDate) : null;

    if (epDate && epDate <= now) {
      // Already aired — but a newer episode may have aired since. Walk
      // forward through peers.next while each next episode has also
      // already aired. Daily/near-daily shows can be many weeks of hops
      // behind a stale saved pid, so the cap here is generous; a transient
      // fetch failure on one hop retries a couple of times before giving up
      // rather than silently stranding the walk on whatever pid it reached.
      let curPid = pid;
      let curDate = broadcastDate!;
      let curInfo = info;
      for (let hops = 0; hops < 200; hops++) {
        const next = curInfo.peers?.next;
        if (!next?.pid) break;
        const nextDate = next.first_broadcast_date ? new Date(next.first_broadcast_date) : null;
        if (!nextDate || nextDate > now) break; // next hasn't aired yet — stop here
        let nextInfo: ProgInfo | null = null;
        for (let attempt = 0; attempt < 3 && !nextInfo; attempt++) {
          nextInfo = await fetchProgInfo(next.pid);
        }
        if (!nextInfo) break;
        curPid = next.pid;
        curDate = next.first_broadcast_date!;
        curInfo = nextInfo;
      }

      if (brandPid && curPid !== brandPid) {
        const viaBrand = await latestPastFromBrand(brandPid);
        if (viaBrand.pid !== curPid) {
          const viaBrandInfo = await fetchProgInfo(viaBrand.pid);
          const viaBrandDate = viaBrandInfo?.first_broadcast_date ? new Date(viaBrandInfo.first_broadcast_date) : null;
          if (viaBrandDate && viaBrandDate > new Date(curDate)) {
            return NextResponse.json({
              episodePid: viaBrand.pid,
              airDate: viaBrand.airDate,
              brandPid, brandTitle,
            });
          }
        }
      }

      return NextResponse.json({
        episodePid: curPid,
        airDate: formatAirDate(curDate),
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
