import fs from "fs";
import path from "path";

// Per-track pace feedback from the activity page: a thumbs-down excludes the
// track from future mixes for segments within ±TOLERANCE of that pace (it
// stays available at other paces); a thumbs-up weights it to appear more
// often at that pace.

const FILE = path.join(process.cwd(), "track-pace-feedback.json");
export const FEEDBACK_PACE_TOLERANCE = 10; // sec/mi — matches the pacing review tolerance

export interface TrackVote {
  uri: string;
  paceSec: number;      // the target pace the vote applies to
  vote: "up" | "down";
  at: string;           // ISO timestamp
}

function loadAll(): TrackVote[] {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf-8")) as { votes?: TrackVote[] };
    return data.votes ?? [];
  } catch {
    return [];
  }
}

function saveAll(votes: TrackVote[]): void {
  fs.writeFileSync(FILE, JSON.stringify({ votes }), "utf-8");
}

export function getAllTrackVotes(): TrackVote[] {
  return loadAll();
}

// Set (or with vote=null clear) this track's vote for paces near paceSec.
export function setTrackVote(uri: string, paceSec: number, vote: "up" | "down" | null): TrackVote[] {
  const votes = loadAll().filter(
    v => !(v.uri === uri && Math.abs(v.paceSec - paceSec) <= FEEDBACK_PACE_TOLERANCE)
  );
  if (vote) votes.push({ uri, paceSec, vote, at: new Date().toISOString() });
  saveAll(votes);
  return votes;
}
