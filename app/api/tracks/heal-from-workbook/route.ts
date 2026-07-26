import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { activeCsvPath } from "@/lib/running-playlist-config";
import { readCsv, writeCsv, isBlank, matchKey } from "@/lib/csv-store";

// Fills in Track URI, Duration, Popularity, Explicit, Genres, Album/Release
// Date, and every audio feature (Tempo/Key/Mode/Energy/Danceability/
// Acousticness/Instrumentalness/Liveness/Valence/Speechiness/Loudness/Time
// Signature) for rows in the active playlist's CSV, from a Chosic-exported
// workbook — parsed client-side (xlsx) into plain JSON rows, matched here
// by Spotify Track ID when the row already has one, else by name+artist.

// "A Major" / "C#/Db Minor" -> Spotify pitch class (0=C..11=B) + mode (1=major/0=minor).
const NOTE_TO_PITCH_CLASS: Record<string, number> = {
  "c": 0, "c#": 1, "db": 1, "d": 2, "d#": 3, "eb": 3, "e": 4, "f": 5,
  "f#": 6, "gb": 6, "g": 7, "g#": 8, "ab": 8, "a": 9, "a#": 10, "bb": 10, "b": 11,
};
function parseChosicKey(text: string): { key: number; mode: number } | null {
  const m = /^([A-Ga-g][#b]?)(?:\/[A-Ga-g][#b]?)?\s+(Major|Minor)$/i.exec(text.trim());
  if (!m) return null;
  const pitch = NOTE_TO_PITCH_CLASS[m[1].toLowerCase().replace("♯", "#").replace("♭", "b")];
  if (pitch === undefined) return null;
  return { key: pitch, mode: /major/i.test(m[2]) ? 1 : 0 };
}

// "MM:SS" -> ms. Chosic rounds to whole seconds, so this loses sub-second
// precision the original library value had — only used when the row has no
// Duration (ms) at all.
function parseChosicDuration(text: string): number | null {
  const m = /^(\d+):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  return (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) * 1000;
}

// Chosic's 0-100 feature scores -> Spotify's native 0.0-1.0.
function pct(v: unknown): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  if (isNaN(n)) return null;
  return Math.round((n / 100) * 1000) / 1000;
}
function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return isNaN(n) ? null : n;
}

interface ChosicRow {
  id?: string;      // Spotify Track ID, bare (no prefix)
  name?: string;
  artist?: string;
  bpm?: unknown;
  energy?: unknown;
  duration?: string; // "MM:SS"
  popularity?: unknown;
  genres?: string;
  album?: string;
  albumDate?: string;
  dance?: unknown;
  acoustic?: unknown;
  instrumental?: unknown;
  valence?: unknown;
  speech?: unknown;
  live?: unknown;
  loudness?: unknown;
  key?: string;      // "A Major"
  timeSignature?: unknown;
  explicit?: string; // "yes" | "no"
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { rows: workbookRows } = await req.json() as { rows?: ChosicRow[] };
  if (!workbookRows?.length) return NextResponse.json({ error: "rows required" }, { status: 400 });

  const byId = new Map<string, ChosicRow>();
  const byNameArtist = new Map<string, ChosicRow>();
  for (const r of workbookRows) {
    if (r.id) byId.set(r.id.trim(), r);
    if (r.name && r.artist) {
      const key = matchKey(r.name, r.artist);
      if (!byNameArtist.has(key)) byNameArtist.set(key, r);
    }
  }

  const csvPath = activeCsvPath();
  const { headers, rows, col } = await readCsv(csvPath);
  const idxUri = col("Track URI");
  const idxName = col("Track Name");
  const idxArtist = col("Artist Name(s)");
  const idxAlbum = col("Album Name");
  const idxReleaseDate = col("Release Date");
  const idxDuration = col("Duration (ms)");
  const idxPopularity = col("Popularity");
  const idxExplicit = col("Explicit");
  const idxGenres = col("Genres");
  const idxDanceability = col("Danceability");
  const idxEnergy = col("Energy");
  const idxKey = col("Key");
  const idxLoudness = col("Loudness");
  const idxMode = col("Mode");
  const idxSpeechiness = col("Speechiness");
  const idxAcousticness = col("Acousticness");
  const idxInstrumentalness = col("Instrumentalness");
  const idxLiveness = col("Liveness");
  const idxValence = col("Valence");
  const idxTempo = col("Tempo");
  const idxTimeSignature = col("Time Signature");
  if (idxUri === -1 || idxName === -1) {
    return NextResponse.json({ error: "Library CSV is missing Track URI/Track Name columns" }, { status: 500 });
  }

  let matched = 0;
  let checked = 0;
  let urisFilled = 0;
  for (const row of rows) {
    checked++;

    const uriVal = row[idxUri]?.trim() ?? "";
    const existingId = uriVal.startsWith("spotify:track:") ? uriVal.split(":").pop()! : null;
    let source: ChosicRow | undefined = existingId ? byId.get(existingId) : undefined;
    if (!source) {
      const name = row[idxName]?.trim() ?? "";
      const artist = idxArtist !== -1 ? (row[idxArtist]?.trim() ?? "") : "";
      if (name && artist) source = byNameArtist.get(matchKey(name, artist));
    }
    if (!source) continue;

    let changed = false;
    const setIfBlank = (idx: number, value: string | null) => {
      if (idx === -1 || value === null || value === "") return;
      if (isBlank(row[idx])) { row[idx] = value; changed = true; }
    };

    if (!existingId && source.id) {
      row[idxUri] = `spotify:track:${source.id.trim()}`;
      changed = true;
      urisFilled++;
    }

    setIfBlank(idxAlbum, source.album?.trim() ?? null);
    setIfBlank(idxReleaseDate, source.albumDate?.trim() ?? null);
    setIfBlank(idxGenres, source.genres?.trim() ?? null);
    setIfBlank(idxPopularity, source.popularity != null ? String(num(source.popularity) ?? "") : null);
    if (source.explicit) setIfBlank(idxExplicit, /^y/i.test(source.explicit) ? "True" : "False");

    const durationMs = source.duration ? parseChosicDuration(source.duration) : null;
    setIfBlank(idxDuration, durationMs != null ? String(durationMs) : null);

    setIfBlank(idxTempo, source.bpm != null ? String(num(source.bpm) ?? "") : null);
    setIfBlank(idxEnergy, pct(source.energy) != null ? String(pct(source.energy)) : null);
    setIfBlank(idxDanceability, pct(source.dance) != null ? String(pct(source.dance)) : null);
    setIfBlank(idxAcousticness, pct(source.acoustic) != null ? String(pct(source.acoustic)) : null);
    setIfBlank(idxInstrumentalness, pct(source.instrumental) != null ? String(pct(source.instrumental)) : null);
    setIfBlank(idxValence, pct(source.valence) != null ? String(pct(source.valence)) : null);
    setIfBlank(idxSpeechiness, pct(source.speech) != null ? String(pct(source.speech)) : null);
    setIfBlank(idxLiveness, pct(source.live) != null ? String(pct(source.live)) : null);
    setIfBlank(idxLoudness, source.loudness != null ? String(num(source.loudness) ?? "") : null);
    setIfBlank(idxTimeSignature, source.timeSignature != null ? String(num(source.timeSignature) ?? "") : null);

    if (source.key) {
      const parsed = parseChosicKey(source.key);
      if (parsed) {
        setIfBlank(idxKey, String(parsed.key));
        setIfBlank(idxMode, String(parsed.mode));
      }
    }

    if (changed) matched++;
  }

  if (matched > 0) await writeCsv(csvPath, headers, rows);

  return NextResponse.json({ checked, matched, urisFilled, workbookRows: workbookRows.length });
}
