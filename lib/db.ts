import Database from "better-sqlite3";
import path from "path";

// Single shared PaceSync database — replaces the ~30 individual flat JSON
// files this app used to store everything in (each read/written via plain
// fs.readFileSync/writeFileSync with no locking beyond one bespoke
// in-process queue in lib/pinned-mixes.ts). Migrated store-by-store in
// batches; see the migration plan for the full schedule.
//
// Deliberately diverges from the read-only GarminDB access pattern used
// elsewhere in this app (require() + open/close per call, readonly mode,
// no WAL): this DB is read-WRITE and can be hit concurrently by overlapping
// Next.js requests, so it needs WAL mode (readers don't block the writer)
// and a single long-lived connection instead of open-per-call. The schema
// is also created here (idempotent CREATE TABLE IF NOT EXISTS) rather than
// assumed to already exist, since this file is the DB's only source of truth
// for its own shape.
//
// claude-config.json/gemini-config.json/ai-dj-usage.json's rows are also
// written directly by a separate Python process (scripts/ai_dj_bridge.py,
// via ai_dj/claude_config.py etc., using Python's stdlib sqlite3 module
// against this exact file) — both sides set the same busy_timeout so a
// write from either side waits instead of failing outright if the other
// holds the write lock at that instant.

const DB_PATH = path.join(process.cwd(), "pacesync.db");

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS kv_config (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS todays_run_history (
  date TEXT NOT NULL,
  workout_title TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  tracks_json TEXT NOT NULL,
  approved INTEGER,
  PRIMARY KEY (date, workout_title)
);

CREATE TABLE IF NOT EXISTS pinned_mixes (
  date TEXT NOT NULL,
  workout_title TEXT NOT NULL,
  total_sec INTEGER NOT NULL,
  timeline_json TEXT NOT NULL,
  pinned_at TEXT NOT NULL,
  started_at_ms INTEGER,
  PRIMARY KEY (date, workout_title)
);

CREATE TABLE IF NOT EXISTS pinned_mixes_cursor (
  date TEXT NOT NULL,
  workout_title TEXT NOT NULL,
  deleted_at_ms INTEGER NOT NULL,
  PRIMARY KEY (date, workout_title)
);

CREATE TABLE IF NOT EXISTS pinned_routes (
  date TEXT NOT NULL,
  workout_title TEXT NOT NULL,
  activity_id TEXT NOT NULL,
  name TEXT NOT NULL,
  distance_mi REAL NOT NULL,
  run_date TEXT NOT NULL,
  pinned_at TEXT NOT NULL,
  PRIMARY KEY (date, workout_title)
);

CREATE TABLE IF NOT EXISTS race_splits (
  date TEXT NOT NULL,
  workout_title TEXT NOT NULL,
  splits_json TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  PRIMARY KEY (date, workout_title)
);

CREATE TABLE IF NOT EXISTS removed_tracks (
  date TEXT NOT NULL,
  workout_title TEXT NOT NULL,
  uris_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (date, workout_title)
);

CREATE TABLE IF NOT EXISTS mix_candidates (
  date TEXT NOT NULL,
  workout_title TEXT NOT NULL,
  segments_json TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  PRIMARY KEY (date, workout_title)
);

CREATE TABLE IF NOT EXISTS recent_mix_builds (
  date TEXT NOT NULL,
  built_at TEXT NOT NULL,
  uris_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS play_counts (
  uri TEXT PRIMARY KEY,
  count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS play_counts_credited (
  date TEXT NOT NULL,
  workout_title TEXT NOT NULL,
  PRIMARY KEY (date, workout_title)
);

CREATE TABLE IF NOT EXISTS deleted_tracks (
  uri TEXT PRIMARY KEY,
  name TEXT,
  artist TEXT,
  deleted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS added_tracks (
  csv_file TEXT NOT NULL,
  uri TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (csv_file, uri)
);

CREATE TABLE IF NOT EXISTS bpm_track_overrides (
  uri TEXT PRIMARY KEY,
  value REAL NOT NULL,
  set_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS track_pace_feedback (
  uri TEXT NOT NULL,
  pace_sec INTEGER NOT NULL,
  vote TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cron_log (
  ts TEXT NOT NULL,
  job TEXT NOT NULL,
  message TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS running_playlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  csv_file TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 0
);

-- One row per track library entry, scoped per playlist (csv_file) — a
-- track can legitimately exist in more than one playlist's library with
-- independently-healed data, so the key is (csv_file, uri), not uri alone.
-- row_no additionally disambiguates the rare rows with no URI at all
-- (a real, currently-tolerated on-disk state — some CSV rows have a blank
-- Track URI cell). Numeric columns stay nullable (not defaulted to 0) so
-- "missing" and "present-but-zero" remain distinguishable, matching the
-- CSV-heal sweep's existing isBlank-based semantics.
CREATE TABLE IF NOT EXISTS tracks (
  csv_file TEXT NOT NULL,
  uri TEXT NOT NULL,
  row_no INTEGER NOT NULL,
  track_name TEXT,
  album_name TEXT,
  artist_names TEXT,
  release_date TEXT,
  duration_ms INTEGER,
  popularity INTEGER,
  explicit TEXT,
  added_by TEXT,
  added_at TEXT,
  genres TEXT,
  record_label TEXT,
  danceability REAL,
  energy REAL,
  key INTEGER,
  loudness REAL,
  mode INTEGER,
  speechiness REAL,
  acousticness REAL,
  instrumentalness REAL,
  liveness REAL,
  valence REAL,
  tempo REAL,
  time_signature INTEGER,
  isrc TEXT,
  PRIMARY KEY (csv_file, uri, row_no)
);
CREATE INDEX IF NOT EXISTS idx_tracks_csv_file ON tracks(csv_file);
`;

let db: Database.Database | null = null;

// One-off column additions for tables that already existed in production
// before the column was added — CREATE TABLE IF NOT EXISTS above only
// covers a table that doesn't exist yet at all, so a genuinely new column
// on an existing table needs its own idempotent ALTER TABLE here. Each
// entry checks pragma table_info first since SQLite has no
// "ADD COLUMN IF NOT EXISTS" of its own.
function runColumnMigrations(conn: Database.Database): void {
  const trackCols = conn.prepare("PRAGMA table_info(tracks)").all() as { name: string }[];
  if (!trackCols.some(c => c.name === "isrc")) {
    conn.exec("ALTER TABLE tracks ADD COLUMN isrc TEXT");
  }
}

export function getDb(): Database.Database {
  if (db) return db;
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA_SQL);
  runColumnMigrations(db);
  return db;
}
