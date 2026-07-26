import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { activeCsvPath } from "@/lib/running-playlist-config";
import { readCsv, writeCsv, isBlank, matchKey } from "@/lib/csv-store";
import { healActiveCsv } from "@/lib/csv-heal";

// Fills in Track URI for rows in the active playlist's CSV that have none,
// by matching name+artist against rows extracted client-side from a
// FreeYourMusic/MediaMonkey-style export workbook ({id, name, artist}).
// The workbook is parsed in the browser (xlsx) — this route only ever sees
// plain JSON rows, no file upload handling needed here.

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { rows: workbookRows } = await req.json() as { rows?: { id?: string; name?: string; artist?: string }[] };
  if (!workbookRows?.length) return NextResponse.json({ error: "rows required" }, { status: 400 });

  const workbookByKey = new Map<string, string>(); // matchKey -> spotify:track:<id>
  for (const r of workbookRows) {
    if (!r.id || !r.name || !r.artist) continue;
    const key = matchKey(r.name, r.artist);
    if (!workbookByKey.has(key)) workbookByKey.set(key, `spotify:track:${r.id}`);
  }
  if (workbookByKey.size === 0) {
    return NextResponse.json({ error: "No usable id/name/artist rows found in the workbook" }, { status: 400 });
  }

  const csvPath = activeCsvPath();
  const { headers, rows, col } = await readCsv(csvPath);
  const idxUri = col("Track URI");
  const idxName = col("Track Name");
  const idxArtist = col("Artist Name(s)");
  if (idxUri === -1 || idxName === -1 || idxArtist === -1) {
    return NextResponse.json({ error: "Library CSV is missing Track URI/Track Name/Artist Name(s) columns" }, { status: 500 });
  }

  let matched = 0;
  let checked = 0;
  for (const row of rows) {
    if (!isBlank(row[idxUri])) continue; // already has a URI — not this route's job
    checked++;
    const name = row[idxName]?.trim() ?? "";
    const artist = row[idxArtist]?.trim() ?? "";
    if (!name || !artist) continue;
    const uri = workbookByKey.get(matchKey(name, artist));
    if (!uri) continue;
    row[idxUri] = uri;
    matched++;
  }

  if (matched > 0) {
    await writeCsv(csvPath, headers, rows);
    // Newly-URI'd rows are still missing duration/features/genres — let the
    // usual heal sweep pick them up same as any other freshly-added track.
    void healActiveCsv().catch(() => {});
  }

  return NextResponse.json({ checked, matched, workbookRows: workbookRows.length });
}
