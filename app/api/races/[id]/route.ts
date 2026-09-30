import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getRace, updateRace, deleteRace, type RaceStatus } from "@/lib/races";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const race = getRace(params.id);
  if (!race) return NextResponse.json({ error: "Race not found" }, { status: 404 });
  return NextResponse.json({ race });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const existing = getRace(params.id);
  if (!existing) return NextResponse.json({ error: "Race not found" }, { status: 404 });

  const body = await req.json() as {
    name?: string; raceDate?: string | null; status?: RaceStatus;
    garminActivityId?: string | null; runnaUid?: string | null; paceProMixId?: string | null;
    distanceMi?: number | null; notes?: string | null;
    garminCourseId?: string | null; garminCourseName?: string | null;
  };
  if (body.name !== undefined && !body.name.trim()) {
    return NextResponse.json({ error: "name cannot be blank" }, { status: 400 });
  }
  if (body.raceDate && !DATE_RE.test(body.raceDate)) {
    return NextResponse.json({ error: "raceDate must be YYYY-MM-DD" }, { status: 400 });
  }

  const race = updateRace(params.id, body);
  return NextResponse.json({ race });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  deleteRace(params.id);
  return NextResponse.json({ ok: true });
}
