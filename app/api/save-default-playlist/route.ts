import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { writeFile } from "fs/promises";
import { join } from "path";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const csv = await req.text();
  if (!csv) {
    return NextResponse.json({ error: "No CSV data" }, { status: 400 });
  }

  const dest = join(process.cwd(), "public", "Running.csv");
  await writeFile(dest, csv, "utf8");
  console.log(`[save-default-playlist] wrote ${csv.length} bytes to ${dest}`);

  return NextResponse.json({ ok: true });
}
