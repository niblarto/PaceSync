import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { cancelHeal } from "@/lib/csv-heal";

// Stops a running heal sweep and clears its progress log — called when the
// Settings page switches the active playlist mid-sweep, since a running
// sweep already has the old playlist's CSV path captured in memory and
// would otherwise keep churning against a library that's no longer active.
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await cancelHeal();
  return NextResponse.json({ ok: true });
}
