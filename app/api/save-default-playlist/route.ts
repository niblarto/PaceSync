import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { writeFile } from "fs/promises";
import { activeCsvPath } from "@/lib/running-playlist-config";
import { healActiveCsv } from "@/lib/csv-heal";
import { mergeCsvIntoFile, parseCsvRow, URI_HEADER_NAMES } from "@/lib/csv-merge";
import { findPreviouslyDeleted, removeFromDeletedLog } from "@/lib/deleted-tracks";

function extractUris(csvText: string): string[] {
  const lines = csvText.replace(/\r/g, "").split("\n").filter(Boolean);
  if (lines.length < 2) return [];
  const header = parseCsvRow(lines[0].replace(/^﻿/, "")).map(h => h.trim());
  const uriIdx = header.findIndex(h => URI_HEADER_NAMES.includes(h.toLowerCase()));
  if (uriIdx === -1) return [];
  return lines.slice(1).map(l => parseCsvRow(l)[uriIdx]?.trim()).filter((u): u is string => !!u);
}

// Any CSV write can introduce rows with missing data — sweep afterwards
// (in the background; upload responses shouldn't wait on API lookups).
function healInBackground(context: string) {
  void healActiveCsv().catch(e => console.warn(`[${context}] heal failed:`, e));
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const mode = req.nextUrl.searchParams.get("mode") === "append" ? "append" : "overwrite";
  const csv = await req.text();
  if (!csv) {
    return NextResponse.json({ error: "No CSV data" }, { status: 400 });
  }

  const dest = activeCsvPath();

  if (mode === "append") {
    // Previously-deleted tracks are held back for review. First call (no
    // confirm flag): if any incoming URI is in the deletion log, nothing is
    // written — the rejected list comes back so the UI can show a review
    // with per-track override checkboxes. Confirmed call (confirm=1 +
    // allowDeletedUris header): everything except the still-rejected tracks
    // is merged, and overridden tracks leave the deletion log.
    const confirmed = req.nextUrl.searchParams.get("confirm") === "1";
    const allowHeader = req.headers.get("x-allow-deleted-uris");
    const allowed = new Set<string>(allowHeader ? JSON.parse(allowHeader) as string[] : []);
    const previouslyDeleted = findPreviouslyDeleted(extractUris(csv));
    const rejected = Object.entries(previouslyDeleted)
      .filter(([uri]) => !allowed.has(uri))
      .map(([uri, d]) => ({ uri, name: d.name, artist: d.artist, deletedAt: d.deletedAt }));

    if (!confirmed && rejected.length > 0) {
      return NextResponse.json({ ok: false, needsReview: true, rejected });
    }

    const overridden = Object.keys(previouslyDeleted).filter(uri => allowed.has(uri));
    if (overridden.length > 0) {
      try { removeFromDeletedLog(overridden); } catch (e) { console.warn("[save-default-playlist] deletion log update failed:", e); }
    }

    const result = await mergeCsvIntoFile(dest, csv, new Set(rejected.map(r => r.uri)));
    console.log(`[save-default-playlist] appended ${result.appended} rows, merged data into ${result.merged} existing rows in ${dest}${rejected.length ? `, rejected ${rejected.length} previously-deleted` : ""}`);
    // Always heal, even when nothing new was appended: the *existing* rows
    // already on disk (e.g. from a migrated/legacy CSV missing feature
    // columns, or ones just merged above) can still have gaps that need
    // backfilling, independent of whether this request added new rows.
    healInBackground("save-default-playlist");
    return NextResponse.json({ ok: true, ...result, rejected });
  }

  await writeFile(dest, csv, "utf8");
  console.log(`[save-default-playlist] wrote ${csv.length} bytes to ${dest}`);
  healInBackground("save-default-playlist");
  return NextResponse.json({ ok: true });
}
