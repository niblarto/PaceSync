import { getDb } from "@/lib/db";

// Per-track pace feedback from the activity page: a thumbs-down excludes the
// track from future mixes for segments within ±TOLERANCE of that pace (it
// stays available at other paces); a thumbs-up weights it to appear more
// often at that pace.

export const FEEDBACK_PACE_TOLERANCE = 10; // sec/mi — matches the pacing review tolerance

export interface TrackVote {
  uri: string;
  paceSec: number;      // the target pace the vote applies to
  vote: "up" | "down";
  at: string;           // ISO timestamp
}

export function getAllTrackVotes(): TrackVote[] {
  const rows = getDb().prepare("SELECT uri, pace_sec, vote, at FROM track_pace_feedback").all() as
    { uri: string; pace_sec: number; vote: string; at: string }[];
  return rows.map(r => ({ uri: r.uri, paceSec: r.pace_sec, vote: r.vote as "up" | "down", at: r.at }));
}

// Set (or with vote=null clear) this track's vote for paces near paceSec.
export function setTrackVote(uri: string, paceSec: number, vote: "up" | "down" | null): TrackVote[] {
  const db = getDb();
  const tx = db.transaction(() => {
    // Every existing vote for this URI within tolerance of paceSec is
    // replaced (matches the JSON-era "filter out near matches, then push
    // the new one" behavior) — no natural single-row key here since a
    // track can have separate votes at different pace bands.
    const nearby = db.prepare("SELECT rowid FROM track_pace_feedback WHERE uri = ? AND ABS(pace_sec - ?) <= ?")
      .all(uri, paceSec, FEEDBACK_PACE_TOLERANCE) as { rowid: number }[];
    const del = db.prepare("DELETE FROM track_pace_feedback WHERE rowid = ?");
    for (const row of nearby) del.run(row.rowid);
    if (vote) {
      db.prepare("INSERT INTO track_pace_feedback (uri, pace_sec, vote, at) VALUES (?, ?, ?, ?)")
        .run(uri, paceSec, vote, new Date().toISOString());
    }
  });
  tx();
  return getAllTrackVotes();
}
