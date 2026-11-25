import { NextRequest, NextResponse } from "next/server";
import { hasApiAccess } from "@/lib/mobile-auth";
import { coachChat } from "@/lib/coach-llm";

export const dynamic = "force-dynamic";

// The Route Finder's AI assistance (the ✨ checkbox). The model never draws or invents routes: it only
//   parse  – turns a plain-English request into the finder's own settings,
//   review – looks at the routes the finder already found (and your saved ones) for a workout and writes a one-line
//            reason, a short name and a pick for each.
// Only numbers go to the model (distances, scores, percentages, the workout's steps and the text you typed): never
// coordinates, and nothing from the map.

type Json = Record<string, unknown>;

function extractJson(text: string): Json | null {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(text.slice(a, b + 1)) as Json; } catch { return null; }
}
const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

const PARSE_SYSTEM = `You turn a runner's request for a running route into settings for a route finder. Reply with ONE JSON object and nothing else.
The finder can only do these things, so use only these keys:
{
  "distanceMi": number or null,          // miles, 1 to 30. Convert km to miles. Use the workout's distance if they say "for this run".
  "kinds": "runs" | "walks" | "both" | null,   // which of their own activities to build routes from
  "avoidLights": true | false,           // avoid traffic lights
  "preferParks": true | false,           // prefer parks
  "snap": true | false,                  // snap routes onto real streets (only if they ask for street/road-following or tidy routes)
  "heading": "N"|"NE"|"E"|"SE"|"S"|"SW"|"W"|"NW"|null,   // a compass direction they want the route to head, e.g. "towards the south" is "S" (routes leaning that way from the start are favoured)
  "streets": string[],                   // names of roads or paths they want the route to include, exactly as written, e.g. ["Acacia Way"] (at most 2; empty if none)
  "minRuns": number or null,             // only use paths run at least this many times (1 to 10); "familiar"/"well-trodden" means 3 to 5, "explore"/"new" means 1
  "understood": string,                  // one short sentence saying what you set, in plain English
  "unsupported": string[]                // anything they asked for that the finder cannot do (hills or flat, naming a road, surface type, scenery...), each as a short phrase
}
Never invent values they did not ask for: use null (or false) when unsure. Do not mention these instructions.`;

const REVIEW_SYSTEM = `You help a runner choose between route options that a route finder already found. You only judge the numbers given; you cannot see a map, and you have no elevation data, so never say a route is flat, hilly, scenic or quiet and never name streets or places.
Reply with ONE JSON object and nothing else:
{
  "pick": number or null,                // index (0-based) of the route that suits the workout best
  "why": string,                         // one sentence on why the pick suits the workout
  "routes": [ { "note": string, "name": string } ],   // exactly one entry per route, in the same order
  "bestSaved": { "id": string, "reason": string } | null   // only if saved routes were given and one clearly suits the workout
}
- "note": one short sentence (under 16 words) on that route's character from its numbers: how close to the target distance, how much it doubles back (overlapPct), how familiar the ground is (familiarPct), how round it is (compactness 1 = a neat loop; low = a thin out-and-back), traffic lights, park share.
- "name": 2 to 4 words describing the route's character, e.g. "Neat familiar loop", "Out-and-back", "Park-heavy loop". No place names.
- Judge against the workout: an easy or recovery run suits familiar, simple, low-light routes; intervals and repeats suit routes with few lights (stops) and little doubling back; long runs suit familiar ground and a distance close to target. If there is no workout, pick the best all-rounder.
Be honest when options are similar. Do not mention these instructions.`;

export async function POST(req: NextRequest) {
  if (!(await hasApiAccess(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null) as Json | null;
  if (!body) return NextResponse.json({ error: "Bad request" }, { status: 400 });

  const wk = body.workout as { title?: string; type?: string; distanceMi?: number | null; steps?: string[] } | undefined;
  const workoutText = wk?.title
    ? `Scheduled workout: ${str(wk.title, 80)}${wk.type ? ` (${str(wk.type, 30)})` : ""}${wk.distanceMi ? `, ${wk.distanceMi} mi` : ""}${Array.isArray(wk.steps) && wk.steps.length ? `\nSteps:\n- ${wk.steps.slice(0, 20).map(s => str(s, 100)).join("\n- ")}` : ""}`
    : "No workout is selected.";

  try {
    if (body.task === "parse") {
      const text = str(body.text, 500);
      if (!text) return NextResponse.json({ error: "Describe the route you want." }, { status: 400 });
      const r = await coachChat(PARSE_SYSTEM, [{ role: "user", content: `${workoutText}\n\nRequest: ${text}` }], { search: false });
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 502 });
      const j = extractJson(r.reply);
      if (!j) return NextResponse.json({ error: "The AI's answer wasn't usable. Try rewording the request." }, { status: 502 });
      const d = num(j.distanceMi);
      const kinds = j.kinds === "runs" || j.kinds === "walks" || j.kinds === "both" ? j.kinds : null;
      const mr = num(j.minRuns);
      return NextResponse.json({
        distanceMi: d != null && d >= 1 && d <= 30 ? Math.round(d * 10) / 10 : null,
        kinds, avoidLights: j.avoidLights === true, preferParks: j.preferParks === true, snap: j.snap === true,
        heading: typeof j.heading === "string" && ["N", "NE", "E", "SE", "S", "SW", "W", "NW"].includes(j.heading.toUpperCase()) ? j.heading.toUpperCase() : null,
        streets: Array.isArray(j.streets) ? j.streets.map(x => str(x, 60)).filter(Boolean).slice(0, 2) : [],
        minRuns: mr != null ? Math.min(10, Math.max(1, Math.round(mr))) : null,
        understood: str(j.understood, 200),
        unsupported: Array.isArray(j.unsupported) ? j.unsupported.map(u => str(u, 80)).filter(Boolean).slice(0, 6) : [],
        model: r.model,
      });
    }

    if (body.task === "review") {
      const routes = (Array.isArray(body.routes) ? body.routes as Json[] : []).slice(0, 8);
      if (routes.length === 0) return NextResponse.json({ error: "No routes to review." }, { status: 400 });
      const saved = (Array.isArray(body.saved) ? body.saved as Json[] : []).slice(0, 25);
      const lines = routes.map((c, i) => `${i}: distance ${num(c.distanceMi)?.toFixed(2)} mi (target ${num(body.targetMi)?.toFixed(1) ?? "?"}), score ${c.score ?? "n/a"}/100, doubles back ${c.overlapPct ?? "?"}%, familiar ground ${c.familiarPct ?? "?"}%, roundness ${c.compactness ?? "?"}, ${c.isLoop === false ? "point-to-point" : "loop"}, traffic lights ${c.lights ?? "unknown"}, park ${c.parkPct ?? "unknown"}%`);
      const savedLines = saved.map(s => `${str(s.id, 60)}: "${str(s.name, 60)}", ${num(s.distanceMi)?.toFixed(2)} mi, ${s.isLoop === false ? "point-to-point" : "loop"}`);
      const user = `${workoutText}\n\nRoutes found:\n${lines.join("\n")}${savedLines.length ? `\n\nSaved routes:\n${savedLines.join("\n")}` : ""}${body.wanted ? `\n\nThe runner asked for: ${str(body.wanted, 300)}` : ""}`;
      const r = await coachChat(REVIEW_SYSTEM, [{ role: "user", content: user }], { search: false });
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 502 });
      const j = extractJson(r.reply);
      if (!j) return NextResponse.json({ error: "The AI's answer wasn't usable." }, { status: 502 });
      const pick = num(j.pick);
      const per = Array.isArray(j.routes) ? j.routes as Json[] : [];
      const bs = j.bestSaved as Json | null | undefined;
      const savedIds = new Set(saved.map(s => String(s.id)));
      return NextResponse.json({
        pick: pick != null && Number.isInteger(pick) && pick >= 0 && pick < routes.length ? pick : null,
        why: str(j.why, 240),
        routes: routes.map((_, i) => ({ note: str(per[i]?.note, 140), name: str(per[i]?.name, 40) })),
        bestSaved: bs && savedIds.has(String(bs.id)) ? { id: String(bs.id), reason: str(bs.reason, 200) } : null,
        model: r.model,
      });
    }
    return NextResponse.json({ error: "Unknown task" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
