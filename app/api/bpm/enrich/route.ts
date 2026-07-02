import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

// Audio features for Spotify tracks via ReccoBeats (free, keyless).
// ReccoBeats accepts Spotify track IDs directly in /v1/audio-features and
// returns an open.spotify.com href we can map back to the requested ID.
// For IDs ReccoBeats doesn't know, we fall back to resolving an ISRC via
// Deezer search (artist + title) — ReccoBeats accepts ISRCs in the same
// endpoint. This mirrors the bpm_matcher Python pipeline.

const BATCH = 40;
const DEEZER_FALLBACK_CAP = 30; // per request — Deezer is rate limited (50 req / 5 s)

interface TrackQuery {
  id: string;
  name?: string;
  artist?: string;
}

interface ReccoFeature {
  href?: string;
  isrc?: string;
  tempo?: number;
  key?: number;
  mode?: number;
  energy?: number;
  danceability?: number;
  valence?: number;
}

export interface TrackFeatures {
  tempo: number;
  key: number;
  mode: number;
  energy: number;
  danceability: number;
  valence: number;
}

const UA = "pacesync/0.1 (running playlist tool)";

function spotifyIdFromHref(href: string | undefined): string | null {
  const m = href?.match(/open\.spotify\.com\/track\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

function toFeatures(f: ReccoFeature): TrackFeatures | null {
  if (f.tempo == null) return null;
  return {
    tempo: Math.round(f.tempo * 1000) / 1000,
    key: f.key ?? -1,
    mode: f.mode ?? 0,
    energy: f.energy ?? 0.5,
    danceability: f.danceability ?? 0.5,
    valence: f.valence ?? 0.5,
  };
}

async function reccoBatch(ids: string[]): Promise<ReccoFeature[]> {
  const out: ReccoFeature[] = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const res = await fetch(
      `https://api.reccobeats.com/v1/audio-features?ids=${ids.slice(i, i + BATCH).join(",")}`,
      { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) },
    );
    if (!res.ok) throw new Error(`ReccoBeats ${res.status}`);
    const data = await res.json() as { content?: ReccoFeature[] };
    out.push(...(data.content ?? []));
  }
  return out;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function deezerIsrc(name: string, artist: string): Promise<string | null> {
  const tryQuery = async (q: string): Promise<number | null> => {
    const res = await fetch(`https://api.deezer.com/search?q=${q}&limit=1`, {
      headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const d = await res.json() as { data?: { id?: number }[] };
    return d.data?.[0]?.id ?? null;
  };

  let id = await tryQuery(encodeURIComponent(`artist:"${artist}" track:"${name}"`));
  if (!id) {
    await sleep(150);
    id = await tryQuery(encodeURIComponent(`${artist} ${name}`));
  }
  if (!id) return null;

  await sleep(150);
  const res = await fetch(`https://api.deezer.com/track/${id}`, {
    headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;
  const t = await res.json() as { isrc?: string };
  return t.isrc || null;
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as { ids?: string[]; tracks?: TrackQuery[] };
  const queries: TrackQuery[] = body.tracks ?? (body.ids ?? []).map(id => ({ id }));
  if (queries.length === 0) return NextResponse.json({ error: "No tracks" }, { status: 400 });

  const features: Record<string, TrackFeatures> = {};
  try {
    // Pass 1: direct Spotify ID lookup
    for (const f of await reccoBatch(queries.map(q => q.id))) {
      const id = spotifyIdFromHref(f.href);
      const feat = id ? toFeatures(f) : null;
      if (id && feat) features[id] = feat;
    }

    // Pass 2: Deezer → ISRC → ReccoBeats for anything still missing
    const missing = queries.filter(q => !features[q.id] && q.name && q.artist);
    const isrcToId = new Map<string, string>();
    for (const q of missing.slice(0, DEEZER_FALLBACK_CAP)) {
      try {
        const isrc = await deezerIsrc(q.name!, q.artist!);
        if (isrc) isrcToId.set(isrc, q.id);
      } catch { /* skip this track */ }
      await sleep(150);
    }
    if (isrcToId.size > 0) {
      for (const f of await reccoBatch(Array.from(isrcToId.keys()))) {
        const id = f.isrc ? isrcToId.get(f.isrc) : null;
        const feat = id ? toFeatures(f) : null;
        if (id && feat && !features[id]) features[id] = feat;
      }
    }

    return NextResponse.json({ features });
  } catch (err) {
    // Return whatever we managed to resolve rather than failing wholesale
    if (Object.keys(features).length > 0) return NextResponse.json({ features });
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
