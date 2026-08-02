import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { activeCsvPath, loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { matchKey } from "@/lib/csv-store";
import { readAllTracks, backfillTrackFields, regenerateCsvFile } from "@/lib/tracks-store";
import { getDb } from "@/lib/db";

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

  const csvFile = loadRunningPlaylistConfig().csvFile;
  const rows = readAllTracks(csvFile);
  if (rows.length === 0) {
    return NextResponse.json({ error: "Library CSV is missing Track URI/Track Name columns" }, { status: 500 });
  }

  let matched = 0;
  let checked = 0;
  let urisFilled = 0;
  const db = getDb();
  const setUriStmt = db.prepare("UPDATE tracks SET uri = ? WHERE csv_file = ? AND row_no = ? AND (uri IS NULL OR uri = '')");
  for (const row of rows) {
    checked++;

    const uriVal = row.uri?.trim() ?? "";
    const existingId = uriVal.startsWith("spotify:track:") ? uriVal.split(":").pop()! : null;
    let source: ChosicRow | undefined = existingId ? byId.get(existingId) : undefined;
    if (!source) {
      const name = row.trackName?.trim() ?? "";
      const artist = row.artistNames?.trim() ?? "";
      if (name && artist) source = byNameArtist.get(matchKey(name, artist));
    }
    if (!source) continue;

    let changed = false;
    let newUri = row.uri;
    const fields: Record<string, string | number | null> = {};
    const setIfBlank = (key: string, current: unknown, value: string | number | null) => {
      if (value === null || value === "") return;
      if (current === null || current === undefined || current === "") { fields[key] = value; changed = true; }
    };

    if (!existingId && source.id) {
      newUri = `spotify:track:${source.id.trim()}`;
      setUriStmt.run(newUri, csvFile, row.rowNo);
      changed = true;
      urisFilled++;
    }

    setIfBlank("albumName", row.albumName, source.album?.trim() ?? null);
    setIfBlank("releaseDate", row.releaseDate, source.albumDate?.trim() ?? null);
    setIfBlank("genres", row.genres, source.genres?.trim() ?? null);
    setIfBlank("popularity", row.popularity, source.popularity != null ? num(source.popularity) : null);
    if (source.explicit) setIfBlank("explicit", row.explicit, /^y/i.test(source.explicit) ? "True" : "False");

    const durationMs = source.duration ? parseChosicDuration(source.duration) : null;
    setIfBlank("durationMs", row.durationMs, durationMs);

    setIfBlank("tempo", row.tempo, source.bpm != null ? num(source.bpm) : null);
    setIfBlank("energy", row.energy, pct(source.energy));
    setIfBlank("danceability", row.danceability, pct(source.dance));
    setIfBlank("acousticness", row.acousticness, pct(source.acoustic));
    setIfBlank("instrumentalness", row.instrumentalness, pct(source.instrumental));
    setIfBlank("valence", row.valence, pct(source.valence));
    setIfBlank("speechiness", row.speechiness, pct(source.speech));
    setIfBlank("liveness", row.liveness, pct(source.live));
    setIfBlank("loudness", row.loudness, source.loudness != null ? num(source.loudness) : null);
    setIfBlank("timeSignature", row.timeSignature, source.timeSignature != null ? num(source.timeSignature) : null);

    if (source.key) {
      const parsed = parseChosicKey(source.key);
      if (parsed) {
        setIfBlank("key", row.key, parsed.key);
        setIfBlank("mode", row.mode, parsed.mode);
      }
    }

    if (Object.keys(fields).length > 0 && newUri) {
      backfillTrackFields(csvFile, newUri, fields);
    }

    if (changed) matched++;
  }

  if (matched > 0) await regenerateCsvFile(csvFile, activeCsvPath());

  return NextResponse.json({ checked, matched, urisFilled, workbookRows: workbookRows.length });
}
