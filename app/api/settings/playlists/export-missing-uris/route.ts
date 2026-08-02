import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { loadRunningPlaylistConfig } from "@/lib/running-playlist-config";
import { listMissingColumn } from "@/lib/tracks-store";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const XLSX = require("xlsx") as typeof import("xlsx");

// Exports every row in the active playlist's CSV missing a Track URI, as an
// .xlsx (name/artist/album columns) — lets the missing tracks be checked
// against another source (a FreeYourMusic workbook, a different export,
// manual lookup) instead of guessing why "Fill URIs from workbook" left
// them unmatched.

export async function GET(_req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const csvRows = listMissingColumn(loadRunningPlaylistConfig().csvFile, "uri", { requireUri: false });

  const rows: { name: string; artist: string; album: string }[] = csvRows.map(row => ({
    name: row.trackName?.trim() ?? "",
    artist: row.artistNames?.trim() ?? "",
    album: row.albumName?.trim() ?? "",
  }));

  const sheet = XLSX.utils.json_to_sheet(rows, { header: ["name", "artist", "album"] });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Missing URIs");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="missing-uris.xlsx"`,
    },
  });
}
