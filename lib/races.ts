import { getDb } from "@/lib/db";

// User-managed race registry — Dashboard -> Races page. See lib/db.ts's
// own comment on the `races` table for why this exists as a separate,
// durable store instead of re-deriving "which races are coming up / just
// happened" from Runna's feed + GarminDB on every page load the way
// components/RunnaCard.tsx already does (and keeps needing bug fixes for —
// Runna's own feed can drop a race's VEVENT, or take time to re-tag it
// completed, or simply never know about a race booked outside the Runna
// plan). A race row here is created once (from the Garmin activity page's
// "Race" checkbox, or added directly on the Races page for an upcoming
// one) and just sits there, independent of whatever Runna's feed says on
// any given day.

export type RaceStatus = "upcoming" | "completed";

export interface Race {
  id: string;
  name: string;
  raceDate: string | null; // YYYY-MM-DD — null for an upcoming race with no date set yet
  status: RaceStatus;
  garminActivityId: string | null; // the completed run this race's course/route comes from
  runnaUid: string | null; // set if this row was created FROM a Runna schedule suggestion
  paceProMixId: string | null; // lib/pace-pro-saved.ts SavedPaceProMix.id
  distanceMi: number | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  // A Garmin Connect COURSE manually linked by URL/ID (app/api/garmin/
  // course-route/[courseId]) — the route source when there's no linked
  // past activity to pull real GPS from yet. Mutually informative, not
  // exclusive, with garminActivityId: an upcoming race typically only has
  // one or the other, but nothing here enforces that.
  garminCourseId: string | null;
  garminCourseName: string | null;
}

interface Row {
  id: string;
  name: string;
  race_date: string | null;
  status: string;
  garmin_activity_id: string | null;
  runna_uid: string | null;
  pace_pro_mix_id: string | null;
  distance_mi: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  garmin_course_id: string | null;
  garmin_course_name: string | null;
}

function rowToRace(r: Row): Race {
  return {
    id: r.id,
    name: r.name,
    raceDate: r.race_date,
    status: r.status === "completed" ? "completed" : "upcoming",
    garminActivityId: r.garmin_activity_id,
    runnaUid: r.runna_uid,
    paceProMixId: r.pace_pro_mix_id,
    distanceMi: r.distance_mi,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    garminCourseId: r.garmin_course_id,
    garminCourseName: r.garmin_course_name,
  };
}

export function listRaces(): Race[] {
  const rows = getDb().prepare("SELECT * FROM races ORDER BY (race_date IS NULL), race_date, created_at DESC").all() as Row[];
  return rows.map(rowToRace);
}

export function getRace(id: string): Race | null {
  const row = getDb().prepare("SELECT * FROM races WHERE id = ?").get(id) as Row | undefined;
  return row ? rowToRace(row) : null;
}

// One race per linked Garmin activity — the "Race" checkbox on the Garmin
// activity page toggles a single row per activity_id, not one-per-click,
// so re-checking an already-race-flagged activity updates the existing
// row instead of creating a duplicate.
export function getRaceByGarminActivity(activityId: string): Race | null {
  const row = getDb().prepare("SELECT * FROM races WHERE garmin_activity_id = ?").get(activityId) as Row | undefined;
  return row ? rowToRace(row) : null;
}

export interface CreateRaceInput {
  name: string;
  raceDate?: string | null;
  status: RaceStatus;
  garminActivityId?: string | null;
  runnaUid?: string | null;
  paceProMixId?: string | null;
  distanceMi?: number | null;
  notes?: string | null;
  garminCourseId?: string | null;
  garminCourseName?: string | null;
}

export function createRace(input: CreateRaceInput): Race {
  const id = `rc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO races (id, name, race_date, status, garmin_activity_id, runna_uid, pace_pro_mix_id, distance_mi, notes, created_at, updated_at, garmin_course_id, garmin_course_name)
    VALUES (@id, @name, @raceDate, @status, @garminActivityId, @runnaUid, @paceProMixId, @distanceMi, @notes, @createdAt, @updatedAt, @garminCourseId, @garminCourseName)
  `).run({
    id,
    name: input.name.trim(),
    raceDate: input.raceDate ?? null,
    status: input.status,
    garminActivityId: input.garminActivityId ?? null,
    runnaUid: input.runnaUid ?? null,
    paceProMixId: input.paceProMixId ?? null,
    distanceMi: input.distanceMi ?? null,
    notes: input.notes ?? null,
    createdAt: now,
    updatedAt: now,
    garminCourseId: input.garminCourseId ?? null,
    garminCourseName: input.garminCourseName ?? null,
  });
  return getRace(id)!;
}

export type UpdateRaceInput = Partial<Omit<CreateRaceInput, "status">> & { status?: RaceStatus };

export function updateRace(id: string, patch: UpdateRaceInput): Race | null {
  const existing = getRace(id);
  if (!existing) return null;
  const next = {
    name: patch.name !== undefined ? patch.name.trim() : existing.name,
    raceDate: patch.raceDate !== undefined ? patch.raceDate : existing.raceDate,
    status: patch.status !== undefined ? patch.status : existing.status,
    garminActivityId: patch.garminActivityId !== undefined ? patch.garminActivityId : existing.garminActivityId,
    runnaUid: patch.runnaUid !== undefined ? patch.runnaUid : existing.runnaUid,
    paceProMixId: patch.paceProMixId !== undefined ? patch.paceProMixId : existing.paceProMixId,
    distanceMi: patch.distanceMi !== undefined ? patch.distanceMi : existing.distanceMi,
    notes: patch.notes !== undefined ? patch.notes : existing.notes,
    garminCourseId: patch.garminCourseId !== undefined ? patch.garminCourseId : existing.garminCourseId,
    garminCourseName: patch.garminCourseName !== undefined ? patch.garminCourseName : existing.garminCourseName,
  };
  getDb().prepare(`
    UPDATE races SET name = @name, race_date = @raceDate, status = @status,
      garmin_activity_id = @garminActivityId, runna_uid = @runnaUid, pace_pro_mix_id = @paceProMixId,
      distance_mi = @distanceMi, notes = @notes, updated_at = @updatedAt,
      garmin_course_id = @garminCourseId, garmin_course_name = @garminCourseName
    WHERE id = @id
  `).run({ id, updatedAt: new Date().toISOString(), ...next });
  return getRace(id);
}

export function deleteRace(id: string): void {
  getDb().prepare("DELETE FROM races WHERE id = ?").run(id);
}

export function deleteRaceByGarminActivity(activityId: string): void {
  getDb().prepare("DELETE FROM races WHERE garmin_activity_id = ?").run(activityId);
}
