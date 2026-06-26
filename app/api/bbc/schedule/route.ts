import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

export interface ScheduleSlot {
  time: string;
  date: string;
  rawDate: string;  // YYYY-MM-DD for date comparisons on the client
  title: string;
  pid: string;
  synopsis: string;
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

function parseScheduleHtml(html: string): ScheduleSlot[] {
  const items: ScheduleSlot[] = [];
  const seen = new Set<string>();
  // BBC PIDs vary by era: 8-char m0/b0/p0 (Sounds-era) or 15-char w1730... (newer Radio 4/WS).
  // Match any alphanumeric PID of 5–20 chars starting with a letter.
  const pidRe = /data-pid="([a-z][a-z0-9]{4,19})"/g;
  let m: RegExpExecArray | null;

  while ((m = pidRe.exec(html)) !== null) {
    const pid = m[1];
    if (seen.has(pid)) continue;

    const before = html.slice(Math.max(0, m.index - 2000), m.index);
    const after  = html.slice(m.index, Math.min(html.length, m.index + 1500));

    // Most-recent broadcast time before this PID: content="YYYY-MM-DDTHH:MM"
    let dateStr = "";
    let timeStr = "";
    const dtRe = /content="(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/g;
    let dtM: RegExpExecArray | null;
    let lastDt: RegExpExecArray | null = null;
    while ((dtM = dtRe.exec(before)) !== null) lastDt = dtM;
    if (lastDt) { dateStr = lastDt[1]; timeStr = lastDt[2]; }

    // Prefer the display time from the timezone--time span (handles DST offsets)
    const tzRe = /class="timezone--time">(\d{2}:\d{2})<\/span>/g;
    let tzM: RegExpExecArray | null;
    let lastTz: RegExpExecArray | null = null;
    while ((tzM = tzRe.exec(before)) !== null) lastTz = tzM;
    const displayTime = lastTz ? lastTz[1] : timeStr;

    let dateLabel = "";
    if (dateStr) {
      try {
        const d = new Date(dateStr + "T12:00:00");
        dateLabel = d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
      } catch {}
    }

    // Require a broadcast date — excludes cross-service promotions with no schedule context
    if (!dateStr) continue;

    // Brand title: class="programme__title ..."
    const titleMatch = after.match(/class="programme__title[^"]*"><span>([^<]+)<\/span>/);
    if (!titleMatch) continue;
    const title = decodeHtml(titleMatch[1]);
    if (!title) continue;

    // Optional episode subtitle
    const subMatch = after.match(/class="programme__subtitle[^"]*"><span>([^<]+)<\/span>/);
    const subtitle = subMatch ? decodeHtml(subMatch[1]) : "";

    // Synopsis
    const synMatch = after.match(/class="programme__synopsis[^"]*"[^>]*>[\s\S]{0,100}?<span>([^<]+)<\/span>/);
    const synopsis = decodeHtml(synMatch?.[1] ?? "");

    seen.add(pid);
    items.push({
      pid,
      time: displayTime,
      date: dateLabel,
      rawDate: dateStr,
      title: subtitle ? `${title} – ${subtitle}` : title,
      synopsis,
    });
  }

  return items;
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = req.nextUrl.searchParams.get("service");
  if (!service) return NextResponse.json({ error: "Missing service" }, { status: 400 });

  try {
    const res = await fetch(
      `https://www.bbc.co.uk/schedules/${service}/this_week`,
      { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) }
    );
    if (!res.ok) return NextResponse.json({ error: `BBC returned ${res.status}` }, { status: 502 });

    const html = await res.text();
    const items = parseScheduleHtml(html);
    return NextResponse.json({ items });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
