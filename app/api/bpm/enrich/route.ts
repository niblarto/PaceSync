import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

// Audio features for Spotify track IDs via ReccoBeats (free, keyless).
// ReccoBeats accepts Spotify track IDs directly in /v1/audio-features and
// returns Spotify-style features with an open.spotify.com href we can map
// back to the requested ID. Used to enrich BBC tracks added to the playlist.

const BATCH = 40;

interface ReccoFeature {
  href?: string;
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

function spotifyIdFromHref(href: string | undefined): string | null {
  const m = href?.match(/open\.spotify\.com\/track\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { ids } = await req.json() as { ids?: string[] };
  if (!ids?.length) return NextResponse.json({ error: "No ids" }, { status: 400 });

  const features: Record<string, TrackFeatures> = {};
  try {
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      const res = await fetch(
        `https://api.reccobeats.com/v1/audio-features?ids=${batch.join(",")}`,
        {
          headers: { "User-Agent": "pacesync/0.1 (running playlist tool)" },
          signal: AbortSignal.timeout(20000),
        },
      );
      if (!res.ok) throw new Error(`ReccoBeats ${res.status}`);
      const data = await res.json() as { content?: ReccoFeature[] };
      for (const f of data.content ?? []) {
        const id = spotifyIdFromHref(f.href);
        if (!id || f.tempo == null) continue;
        features[id] = {
          tempo: Math.round(f.tempo * 1000) / 1000,
          key: f.key ?? -1,
          mode: f.mode ?? 0,
          energy: f.energy ?? 0.5,
          danceability: f.danceability ?? 0.5,
          valence: f.valence ?? 0.5,
        };
      }
    }
    return NextResponse.json({ features });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
