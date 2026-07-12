import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { writeFile } from "fs/promises";
import { activeCsvPath } from "@/lib/running-playlist-config";
import { healActiveCsv } from "@/lib/csv-heal";
import { mergeCsvIntoFile } from "@/lib/csv-merge";

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
    const result = await mergeCsvIntoFile(dest, csv);
    console.log(`[save-default-playlist] appended ${result.appended} rows, merged data into ${result.merged} existing rows in ${dest}`);
    // Always heal, even when nothing new was appended: the *existing* rows
    // already on disk (e.g. from a migrated/legacy CSV missing feature
    // columns, or ones just merged above) can still have gaps that need
    // backfilling, independent of whether this request added new rows.
    healInBackground("save-default-playlist");
    return NextResponse.json({ ok: true, ...result });
  }

  await writeFile(dest, csv, "utf8");
  console.log(`[save-default-playlist] wrote ${csv.length} bytes to ${dest}`);
  healInBackground("save-default-playlist");
  return NextResponse.json({ ok: true });
}
