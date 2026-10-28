#!/usr/bin/env python3
"""Nightly PaceSync backup → the Samba share \\\\FILESERVER\\Backups\\PaceSync.

Runs on the Pi from cron (deploy.py installs it for 03:15). Standard library
only. Restore with scripts/pacesync_restore.sh (a copy is kept on the share).

What goes where (under PaceSync/ on the share):

  daily/pacesync-YYYY-MM-DD_HHMM.tar.zst   one per night, newest 30 kept.
      The app folder minus what a rebuild recreates (node_modules, .next,
      model + image caches), so: source, .env.local, every *.json state file,
      the CSV playlists, a consistent snapshot of pacesync.db, the GarminDB
      config + tokens + helper scripts, the Docker reverse proxy (config and
      certificates), the crontab, the systemd unit and version/package lists.
  mirror/HealthData/ and mirror/running-playlist-cache/
      rsync mirrors (incremental, so only changed files travel) of the big
      Garmin data and the album-art cache. One current copy, not versioned.
  latest.json, RESTORE.txt, pacesync_restore.sh
      Status of the last run, how to restore, and the restore script itself.

The login for the share is in ~/.pacesync-backup.cred (username= / password=
lines, chmod 600) — never in the repo. A failed run sends an ntfy push.
"""
from __future__ import annotations

import datetime
import fcntl
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
import traceback
import urllib.request
from pathlib import Path

HOME = Path.home()
APP = HOME / "running-playlist"
DB = APP / "pacesync.db"
CRED = HOME / ".pacesync-backup.cred"
WORK = HOME / ".cache" / "pacesync-backup"
STATUS = HOME / ".pacesync-backup-status.json"
LOCK = WORK / "lock"

MOUNT = Path("/mnt/pacesync-backup")
HOSTS = ["192.168.0.31", "fileserver.local"]  # IP first; the mDNS name if it ever moves
SHARE = "Backups"
DEST_DIR = "PaceSync"
SMB_VERSIONS = ["3.1.1", "3.0", "2.1"]

KEEP_DAILY = 30
MIN_FREE_GB = 20
MAX_MIRROR_DELETES = 2000  # rsync refuses to delete more than this in one run

# Archived, relative to $HOME.
INCLUDE = ["running-playlist", ".GarminDb", "garmin_run.py", "garmindb", "nginx-proxy-manager"]
# Not archived: rebuilt by npm/next, re-downloaded, mirrored separately, or
# replaced by the consistent snapshot below.
EXCLUDE = [
    "running-playlist/node_modules", "running-playlist/.next", "running-playlist/.fastembed",
    "running-playlist/cache",
    "running-playlist/pacesync.db", "running-playlist/pacesync.db-wal", "running-playlist/pacesync.db-shm",
    "nginx-proxy-manager/data/logs",
    "nginx-proxy-manager/data/database.sqlite", "nginx-proxy-manager/data/database.sqlite-wal",
    "nginx-proxy-manager/data/database.sqlite-shm",
]
# SQLite files snapshotted with .backup (safe while in use) → _backup/snapshots/.
SNAPSHOTS = {
    "pacesync.db": (DB, False),
    "nginx-proxy-manager-database.sqlite": (HOME / "nginx-proxy-manager" / "data" / "database.sqlite", True),  # root-owned
}
# Big, mostly-unchanging data, mirrored incrementally.
MIRRORS = {
    "HealthData": HOME / "HealthData",
    "running-playlist-cache": APP / "cache",
}


class BackupError(Exception):
    pass


def log(msg: str) -> None:
    print(f"[{datetime.datetime.now():%Y-%m-%d %H:%M:%S}] {msg}", flush=True)


def sh(cmd: list[str], *, check: bool = True, timeout: int | None = None, **kw) -> subprocess.CompletedProcess:
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, **kw)
    if check and r.returncode != 0:
        raise BackupError(f"{' '.join(cmd[:3])}… failed ({r.returncode}): {(r.stderr or r.stdout).strip()[-400:]}")
    return r


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return str(n)


# ── The share ──────────────────────────────────────────────────────────────

def is_mounted() -> bool:
    return subprocess.run(["mountpoint", "-q", str(MOUNT)]).returncode == 0


def mount_share() -> tuple[str, bool]:
    """Mounts the share; returns (description, we_mounted_it)."""
    if is_mounted():
        return "already mounted", False
    if not CRED.exists():
        raise BackupError(f"{CRED} is missing: create it with 'username=' and 'password=' lines (chmod 600)")
    sh(["sudo", "-n", "mkdir", "-p", str(MOUNT)])
    errors: list[str] = []
    for host in HOSTS:
        for vers in SMB_VERSIONS:
            r = subprocess.run(
                ["sudo", "-n", "mount", "-t", "cifs", f"//{host}/{SHARE}", str(MOUNT), "-o",
                 f"credentials={CRED},uid={os.getuid()},gid={os.getgid()},file_mode=0660,dir_mode=0770,"
                 f"vers={vers},iocharset=utf8,soft,serverino"],
                capture_output=True, text=True, timeout=60)
            if r.returncode == 0:
                return f"//{host}/{SHARE} (SMB {vers})", True
            errors.append(f"{host} {vers}: {(r.stderr or r.stdout).strip()[-120:]}")
    raise BackupError("could not mount the share: " + " | ".join(errors[-3:]))


def unmount_share() -> None:
    r = subprocess.run(["sudo", "-n", "umount", str(MOUNT)], capture_output=True, text=True)
    if r.returncode != 0:
        subprocess.run(["sudo", "-n", "umount", "-l", str(MOUNT)], capture_output=True, text=True)


# ── Pieces of the archive ──────────────────────────────────────────────────

def snapshot_databases(stage: Path) -> dict[str, dict]:
    """Consistent copies of the live SQLite files (WAL-safe), each integrity-checked."""
    out: dict[str, dict] = {}
    snap = stage / "_backup" / "snapshots"
    snap.mkdir(parents=True, exist_ok=True)
    for name, (src, as_root) in SNAPSHOTS.items():
        if not src.exists():
            continue
        dst = snap / name
        sudo = ["sudo", "-n"] if as_root else []
        sh(sudo + ["sqlite3", "-cmd", ".timeout 30000", str(src), f".backup '{dst}'"], timeout=300)
        if as_root:
            sh(["sudo", "-n", "chown", f"{os.getuid()}:{os.getgid()}", str(dst)])
        con = sqlite3.connect(f"file:{dst}?mode=ro", uri=True)
        try:
            check = con.execute("PRAGMA integrity_check").fetchone()[0]
            tables = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
            rows = {t: con.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in tables}
        finally:
            con.close()
        if check != "ok":
            raise BackupError(f"{name} snapshot failed its integrity check: {check}")
        out[name] = {"bytes": dst.stat().st_size, "tables": len(tables), "rows": sum(rows.values()), "rowCounts": rows}
        log(f"snapshot {name}: {human(dst.stat().st_size)}, {len(tables)} tables, integrity ok")
    return out


def capture_system(stage: Path) -> None:
    """What isn't a file in the app folder but is needed to rebuild the Pi's setup."""
    d = stage / "_backup" / "system"
    d.mkdir(parents=True, exist_ok=True)
    (d / "crontab.txt").write_text(sh(["crontab", "-l"], check=False).stdout)
    unit = Path("/etc/systemd/system/running-playlist.service")
    if unit.exists():
        shutil.copy(unit, d / unit.name)
    venv_pip = HOME / "garmindb-venv" / "bin" / "pip"
    if venv_pip.exists():
        (d / "garmindb-requirements.txt").write_text(sh([str(venv_pip), "freeze"], check=False).stdout)
    versions = [
        sh(["uname", "-a"], check=False).stdout.strip(),
        sh(["node", "-v"], check=False).stdout.strip(),
        "npm " + sh(["npm", "-v"], check=False).stdout.strip(),
        sh(["python3", "-V"], check=False).stdout.strip(),
        sh(["sh", "-c", "grep PRETTY_NAME /etc/os-release"], check=False).stdout.strip(),
        "docker containers: " + sh(["sh", "-c", "docker ps --format '{{.Names}} {{.Image}}' 2>/dev/null | tr '\\n' ';'"], check=False).stdout.strip(),
    ]
    (d / "versions.txt").write_text("\n".join(versions) + "\n")


def build_archive(stage: Path, out: Path) -> None:
    """tar | zstd, run through sudo so root-owned files (the proxy's certificates) are read too."""
    members = [m for m in INCLUDE if (HOME / m).exists()]
    tar_cmd = ["sudo", "-n", "tar", "--warning=no-file-changed", "-cf", "-"]
    for e in EXCLUDE:
        tar_cmd += ["--exclude", e]
    tar_cmd += ["-C", str(HOME)] + members + ["-C", str(stage), "_backup"]
    log(f"archiving {', '.join(members)} (+ snapshots, system info)")
    with open(out, "wb") as f, open(WORK / "tar.err", "w+b") as terr_file:
        tar = subprocess.Popen(tar_cmd, stdout=subprocess.PIPE, stderr=terr_file)
        zst = subprocess.Popen(["zstd", "-T2", "-3", "-q", "-c"], stdin=tar.stdout, stdout=f, stderr=subprocess.PIPE)
        assert tar.stdout is not None
        tar.stdout.close()
        zerr = zst.communicate()[1]
        tar.wait()
        terr_file.seek(0)
        terr = terr_file.read()
    # tar exits 1 for "a file changed while being read" (logs, json being rewritten): fine.
    if tar.returncode not in (0, 1):
        raise BackupError(f"tar failed ({tar.returncode}): {terr.decode(errors='replace')[-300:]}")
    if zst.returncode != 0:
        raise BackupError(f"zstd failed ({zst.returncode}): {zerr.decode(errors='replace')[-300:]}")


def verify_archive(path: Path) -> int:
    """Decompresses the whole archive and checks the snapshot made it in. Returns the file count."""
    sh(["zstd", "-t", "-q", str(path)], timeout=900)
    listing = subprocess.run(["sh", "-c", f"zstd -dc '{path}' | tar -tf -"], capture_output=True, text=True, timeout=900)
    if listing.returncode != 0:
        raise BackupError(f"archive does not list cleanly: {listing.stderr.strip()[-300:]}")
    names = listing.stdout.splitlines()
    for must in ("_backup/snapshots/pacesync.db", "running-playlist/.env.local", "_backup/system/crontab.txt"):
        if must not in names:
            raise BackupError(f"archive is missing {must}")
    return len(names)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def copy_to_share(local: Path, dest_dir: Path) -> Path:
    """Copy under a temporary name, read it back and compare checksums, then rename."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    final = dest_dir / local.name
    part = dest_dir / (local.name + ".part")
    shutil.copyfile(local, part)
    want = sha256(local)
    got = sha256(part)
    if want != got:
        part.unlink(missing_ok=True)
        raise BackupError(f"checksum mismatch after copying to the share ({want[:12]} != {got[:12]})")
    part.rename(final)
    (dest_dir / (local.name + ".sha256")).write_text(f"{want}  {local.name}\n")
    return final


def prune(daily_dir: Path) -> list[str]:
    archives = sorted(daily_dir.glob("pacesync-*.tar.zst"))
    removed = []
    for old in archives[:-KEEP_DAILY]:
        old.unlink(missing_ok=True)
        (daily_dir / (old.name + ".sha256")).unlink(missing_ok=True)
        removed.append(old.name)
    for stale in daily_dir.glob("*.part"):  # an interrupted earlier copy
        stale.unlink(missing_ok=True)
    return removed


def run_mirror(name: str, src: Path, dest_root: Path) -> dict:
    if not src.is_dir() or not any(src.iterdir()):
        raise BackupError(f"mirror source {src} is missing or empty; not mirroring (would wipe the copy)")
    dest = dest_root / name
    dest.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    # SMB has no unix ownership/permissions and 2 s timestamp granularity.
    r = subprocess.run(
        ["rsync", "-rlt", "--delete", f"--max-delete={MAX_MIRROR_DELETES}", "--modify-window=2", "--inplace",
         "--no-perms", "--no-owner", "--no-group", "--stats", f"{src}/", f"{dest}/"],
        capture_output=True, text=True, timeout=4 * 3600)
    if r.returncode not in (0, 24):  # 24: files vanished while copying (logs, temp files)
        raise BackupError(f"rsync {name} failed ({r.returncode}): {(r.stderr or r.stdout).strip()[-300:]}")
    sent = next((l.split(":")[1].strip() for l in r.stdout.splitlines() if l.startswith("Total transferred file size")), "?")
    files = next((l.split(":")[1].strip() for l in r.stdout.splitlines() if l.startswith("Number of regular files transferred")), "?")
    log(f"mirror {name}: {files} files changed, {sent} transferred in {time.time() - t0:.0f}s")
    return {"filesChanged": files, "transferred": sent, "seconds": round(time.time() - t0)}


RESTORE_TXT = """PACESYNC BACKUP - how to restore
=================================
This folder is written every night by scripts/pacesync_backup.py on the Pi.

  daily/pacesync-<date>.tar.zst   The app and its data (one per night, newest 30 kept).
  mirror/HealthData/              Current copy of the Garmin data (GarminDB, FIT files).
  mirror/running-playlist-cache/  Current copy of the album-art cache.
  latest.json                     Result of the last run.
  pacesync_restore.sh             The restore script (also inside every archive).

Rebuilding the Pi from nothing
  1. Install Raspberry Pi OS, create the user "scott", and install: nodejs 20, npm, python3,
     zstd, rsync, sqlite3, docker (with the compose plugin), cifs-utils.
  2. Copy a daily archive and pacesync_restore.sh to the Pi (or mount this share there).
  3. Run:   bash pacesync_restore.sh daily/pacesync-<date>.tar.zst --mirror mirror
     It stops the service, unpacks everything into /home/scott, puts the consistent database
     snapshot in place, restores HealthData and the cache from the mirror, reinstalls the
     crontab and systemd service, runs 'npm ci' and 'npm run build', recreates the Garmin
     virtualenv, starts the reverse proxy container and starts the app.

Safe rehearsal (changes nothing on the Pi):
     bash pacesync_restore.sh daily/pacesync-<date>.tar.zst --dest /tmp/restore-test

Not in the backup: node_modules, .next and the embedding-model cache (rebuilt by the restore),
and anything outside the PaceSync app (other apps on the Pi, the Pi's OS).
The archives contain secrets (.env.local, API tokens, certificates): keep this share private.
"""


def main() -> int:
    WORK.mkdir(parents=True, exist_ok=True)
    lock = open(LOCK, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        log("another backup is already running; exiting")
        return 0
    try:
        os.nice(19)
    except OSError:
        pass
    subprocess.run(["ionice", "-c", "3", "-p", str(os.getpid())], capture_output=True)

    started = datetime.datetime.now()
    status: dict = {"ok": False, "startedAt": started.isoformat(timespec="seconds")}
    mounted_by_us = False
    try:
        log("=== PaceSync backup started ===")
        where, mounted_by_us = mount_share()
        log(f"share: {where}")
        root = MOUNT / DEST_DIR
        root.mkdir(parents=True, exist_ok=True)
        free = shutil.disk_usage(MOUNT).free / 1e9
        if free < MIN_FREE_GB:
            raise BackupError(f"only {free:.1f} GB free on the share (need {MIN_FREE_GB})")

        stage = WORK / "stage"
        shutil.rmtree(stage, ignore_errors=True)
        stage.mkdir(parents=True)
        local = WORK / f"pacesync-{started:%Y-%m-%d_%H%M}.tar.zst"

        snaps = snapshot_databases(stage)
        capture_system(stage)
        manifest = {
            "createdAt": started.isoformat(timespec="seconds"),
            "host": os.uname().nodename,
            "include": INCLUDE, "exclude": EXCLUDE, "snapshots": snaps,
        }
        (stage / "_backup" / "MANIFEST.json").write_text(json.dumps(manifest, indent=1))
        restore_script = Path(__file__).with_name("pacesync_restore.sh")
        if restore_script.exists():
            shutil.copy(restore_script, stage / "_backup" / "pacesync_restore.sh")

        build_archive(stage, local)
        files = verify_archive(local)
        log(f"archive {local.name}: {human(local.stat().st_size)}, {files} entries, verified")

        copy_to_share(local, root / "daily")
        removed = prune(root / "daily")
        log(f"copied to the share and checksum-verified; pruned {len(removed)} old archive(s)")

        mirrors = {}
        for name, src in MIRRORS.items():
            mirrors[name] = run_mirror(name, src, root / "mirror")

        (root / "RESTORE.txt").write_text(RESTORE_TXT)
        if restore_script.exists():
            shutil.copyfile(restore_script, root / "pacesync_restore.sh")

        status.update(ok=True, archive=local.name, archiveBytes=local.stat().st_size, files=files,
                      databases={k: {"bytes": v["bytes"], "rows": v["rows"]} for k, v in snaps.items()},
                      mirrors=mirrors, daily=len(list((root / "daily").glob("pacesync-*.tar.zst"))),
                      shareFreeGB=round(shutil.disk_usage(MOUNT).free / 1e9, 1))
        local.unlink(missing_ok=True)
        shutil.rmtree(stage, ignore_errors=True)
        return 0
    except Exception as e:  # noqa: BLE001 - every failure must be reported
        status["error"] = str(e) if isinstance(e, BackupError) else f"{type(e).__name__}: {e}"
        log("FAILED: " + status["error"])
        if not isinstance(e, BackupError):
            traceback.print_exc()
        return 1
    finally:
        finished = datetime.datetime.now()
        status["finishedAt"] = finished.isoformat(timespec="seconds")
        status["seconds"] = round((finished - started).total_seconds())
        STATUS.write_text(json.dumps(status, indent=1))
        try:
            if is_mounted():
                (MOUNT / DEST_DIR / "latest.json").write_text(json.dumps(status, indent=1))
        except OSError:
            pass
        if mounted_by_us:
            unmount_share()
        if not status["ok"]:
            notify_failure(status.get("error", "unknown error"))
        else:
            log(f"=== backup OK in {status['seconds']}s ===")


def notify_failure(error: str) -> None:
    """ntfy push (JSON publish, as lib/ntfy.ts does); the topic is in the app's database."""
    try:
        con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=10)
        row = con.execute("SELECT value_json FROM kv_config WHERE key = 'ntfy_config'").fetchone()
        con.close()
        topic = json.loads(row[0]).get("topic") if row else None
        if not topic:
            return
        body = json.dumps({"topic": topic, "title": "PaceSync backup failed", "message": error[:500],
                           "priority": 4, "tags": ["warning"]}).encode()
        req = urllib.request.Request("https://ntfy.sh", data=body, headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=15).read()
    except Exception as e:  # noqa: BLE001
        log(f"could not send the failure notification: {e}")


if __name__ == "__main__":
    sys.exit(main())
