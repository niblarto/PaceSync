import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { loadCadenceBuckets, loadKindCadenceBuckets } from "@/lib/ai-dj-mix";
import { loadBpmOverrides, type RunKind } from "@/lib/bpm-overrides";
import { getLastEasyPaceSec } from "@/lib/todays-run-history";

// Advanced AI DJ Mix: the default BPM the mixer would aim for on each
// segment, shown as the placeholder in that segment's BPM boxes. Mirrors
// ai_dj/workout.py's _segment_kind + pace_to_bpm (kind cadence buckets,
// then all-runs buckets, then the 171 spm @ 9:15/mi formula), plus the
// Settings run-type min/max for the segment's kind.
//   POST { segments: string[] } -> { defaults: SegmentDefault[] }
export const dynamic = "force-dynamic";

const DEFAULT_EASY_PACE = 555; // 9:15/mi, ai_dj/workout.py DEFAULT_EASY_PACE

function segmentKind(text: string): RunKind | "strength" {
  const t = text.toLowerCase();
  if (t.includes("strength")) return "strength";
  if (t.includes("warm up") || t.includes("warmup")) return "warmup";
  if (t.includes("cool down") || t.includes("cooldown")) return "cooldown";
  if (t.includes("conversational") || t.includes("easy") || t.includes("recovery")) return "easy";
  return "work";
}

function nearestBucket(buckets: Record<string, number> | null | undefined, paceSec: number): number | null {
  if (!buckets) return null;
  let best: number | null = null;
  for (const k of Object.keys(buckets)) {
    const b = Number(k);
    if (best == null || Math.abs(b - paceSec) < Math.abs(best - paceSec)) best = b;
  }
  return best != null && Math.abs(best - paceSec) <= 15 ? Math.round(buckets[String(best)]) : null;
}

export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { segments } = await req.json().catch(() => ({})) as { segments?: string[] };
  if (!Array.isArray(segments)) return NextResponse.json({ error: "segments required" }, { status: 400 });

  const overrides = loadBpmOverrides();
  const cadence = loadCadenceBuckets();
  const kindCadence = loadKindCadenceBuckets();
  const easyPace = getLastEasyPaceSec() ?? DEFAULT_EASY_PACE;

  const defaults = segments.map(segment => {
    const kind = segmentKind(segment);
    const m = segment.match(/(\d{1,2}):(\d{2})\s*\/\s*mi/i);
    const paceSec = m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : kind === "strength" ? null : easyPace;
    const o = kind !== "strength" ? overrides[kind] : undefined;
    // Cadence at this pace — warm up/easy/cool down/rest read the "easy"
    // profile, work the "work" one (workout.py: kind="easy" if seg.kind in
    // WIDE_TOLERANCE_KINDS else "work").
    let paceBpm: number | null = null;
    if (paceSec != null) {
      paceBpm = (kind !== "strength" ? nearestBucket(kindCadence?.[kind === "work" ? "work" : "easy"], paceSec) : null)
        ?? nearestBucket(cadence, paceSec)
        ?? Math.round(Math.min(Math.max(171 + (555 - paceSec) / 30, 164), 180));
    }
    // ...then clamped into the run type's Settings range, as the mixer does.
    let targetBpm = paceBpm;
    if (targetBpm != null && o?.max != null) targetBpm = Math.min(targetBpm, o.max);
    if (targetBpm != null && o?.min != null) targetBpm = Math.max(targetBpm, o.min);
    return { segment, kind, paceSec, paceBpm, targetBpm, min: o?.min ?? null, max: o?.max ?? null };
  });
  return NextResponse.json({ defaults });
}
