import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { garminConnectGet } from "@/lib/garmin-connect";

export const dynamic = "force-dynamic";

// GET ?date=YYYY-MM-DD → one night's minute-by-minute detail from Garmin Connect, for the Health page's timeline popup:
// sleep stages as segments, overnight HRV readings (every 5 min) and sleep heart rate. Times are epoch ms.

interface RawNight {
  dailySleepDTO?: { sleepStartTimestampGMT?: number; sleepEndTimestampGMT?: number; sleepTimeSeconds?: number; sleepScores?: { overall?: { value?: number } } };
  sleepLevels?: { startGMT?: string | number; endGMT?: string | number; activityLevel?: number }[];
  sleepHeartRate?: { value?: number; startGMT?: number }[];
  hrvData?: { value?: number; startGMT?: number }[];
  avgOvernightHrv?: number;
}

function ms(v: string | number | undefined): number | null {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return null;
  const t = Date.parse(/Z|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`); // Garmin's "GMT" strings carry no zone
  return Number.isFinite(t) ? t : null;
}

export async function GET(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const date = req.nextUrl.searchParams.get("date") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "date required" }, { status: 400 });
  try {
    const raw = await garminConnectGet<RawNight>(`/sleep-service/sleep/dailySleepData?date=${date}&nonSleepBufferMinutes=60`);
    // activityLevel: 0 deep, 1 light, 2 REM, 3 awake
    const stages = (raw.sleepLevels ?? []).flatMap(l => {
      const s = ms(l.startGMT), e = ms(l.endGMT);
      const k = ["deep", "light", "rem", "awake"][l.activityLevel ?? -1];
      return s != null && e != null && k ? [{ start: s, end: e, stage: k }] : [];
    });
    const series = (a: { value?: number; startGMT?: number }[] | undefined) =>
      (a ?? []).flatMap(p => (typeof p.value === "number" && typeof p.startGMT === "number" ? [{ t: p.startGMT, v: p.value }] : [])).sort((x, y) => x.t - y.t);
    const start = raw.dailySleepDTO?.sleepStartTimestampGMT ?? stages[0]?.start ?? null;
    const end = raw.dailySleepDTO?.sleepEndTimestampGMT ?? stages[stages.length - 1]?.end ?? null;
    if (start == null || end == null) return NextResponse.json({ error: "No detailed sleep data for that night." }, { status: 404 });
    return NextResponse.json({
      date, start, end, stages, hrv: series(raw.hrvData), heartRate: series(raw.sleepHeartRate),
      avgHrv: raw.avgOvernightHrv ?? null, score: raw.dailySleepDTO?.sleepScores?.overall?.value ?? null,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
