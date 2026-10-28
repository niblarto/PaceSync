#!/usr/bin/env bash
# Restores a PaceSync backup made by scripts/pacesync_backup.py.
#
#   pacesync_restore.sh ARCHIVE.tar.zst [--mirror DIR] [--dest DIR] [--yes] [--skip-build]
#
#   ARCHIVE      a daily/pacesync-<date>.tar.zst from the backup share
#   --mirror DIR the share's mirror/ folder (HealthData + album-art cache). Without it
#                the Garmin data is re-downloaded by the next GarminDB sync instead.
#   --dest DIR   REHEARSAL: unpack into DIR and check the result; nothing on the Pi is
#                touched (no service stop, crontab, systemd, npm, docker).
#   --yes        don't ask for confirmation
#   --skip-build don't run npm ci / npm run build
#
# A real restore (no --dest) moves any existing ~/running-playlist aside to
# ~/running-playlist.before-restore-<time> instead of overwriting it.
set -euo pipefail

ARCHIVE="" MIRROR="" DEST="$HOME" ASSUME_YES=0 SKIP_BUILD=0
usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --mirror) MIRROR="${2:?--mirror needs a folder}"; shift 2 ;;
    --dest) DEST="${2:?--dest needs a folder}"; shift 2 ;;
    --yes) ASSUME_YES=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    -h|--help) usage 0 ;;
    -*) echo "unknown option $1" >&2; usage 1 ;;
    *) ARCHIVE="$1"; shift ;;
  esac
done
[ -n "$ARCHIVE" ] && [ -f "$ARCHIVE" ] || { echo "give the path of a pacesync-*.tar.zst archive" >&2; usage 1; }

REAL=0; [ "$(realpath -m "$DEST")" = "$(realpath -m "$HOME")" ] && REAL=1
say() { printf '\n== %s\n' "$*"; }

say "Checking the archive"
if [ -f "$ARCHIVE.sha256" ]; then
  want=$(cut -d' ' -f1 "$ARCHIVE.sha256"); got=$(sha256sum "$ARCHIVE" | cut -d' ' -f1)
  [ "$want" = "$got" ] && echo "checksum ok" || { echo "CHECKSUM MISMATCH: the archive is damaged" >&2; exit 1; }
fi
zstd -t -q "$ARCHIVE" && echo "archive decompresses cleanly"

if [ "$REAL" = 1 ]; then
  say "This will restore PaceSync into $HOME"
  echo "The current ~/running-playlist is moved aside, not deleted. The service is stopped meanwhile."
  if [ "$ASSUME_YES" != 1 ]; then read -r -p "Continue? [y/N] " a; [ "$a" = y ] || [ "$a" = Y ] || exit 1; fi
  sudo systemctl stop running-playlist 2>/dev/null || true
  if [ -e "$HOME/running-playlist" ]; then
    aside="$HOME/running-playlist.before-restore-$(date +%Y%m%d-%H%M%S)"
    mv "$HOME/running-playlist" "$aside" && echo "moved the existing app to $aside"
  fi
  TAR="sudo tar"
else
  say "REHEARSAL into $DEST (the Pi itself is not touched)"
  mkdir -p "$DEST"; TAR="tar"
fi

say "Unpacking"
zstd -dc "$ARCHIVE" | $TAR -xpf - -C "$DEST"
APP="$DEST/running-playlist"

say "Putting the consistent database snapshots in place"
rm -f "$APP/pacesync.db-wal" "$APP/pacesync.db-shm"
cp "$DEST/_backup/snapshots/pacesync.db" "$APP/pacesync.db"
if [ -f "$DEST/_backup/snapshots/nginx-proxy-manager-database.sqlite" ]; then
  if [ "$REAL" = 1 ]; then
    sudo install -o root -g root -m 644 "$DEST/_backup/snapshots/nginx-proxy-manager-database.sqlite" "$DEST/nginx-proxy-manager/data/database.sqlite"
  else
    mkdir -p "$DEST/nginx-proxy-manager/data"; cp "$DEST/_backup/snapshots/nginx-proxy-manager-database.sqlite" "$DEST/nginx-proxy-manager/data/database.sqlite"
  fi
fi
echo "pacesync.db: $(sqlite3 "$APP/pacesync.db" 'PRAGMA integrity_check') (integrity), $(sqlite3 "$APP/pacesync.db" "select count(*) from sqlite_master where type='table'") tables"
for t in kv_config tracks loseit_food_log coach_messages races; do
  printf '  %-18s %s rows\n' "$t" "$(sqlite3 "$APP/pacesync.db" "select count(*) from $t" 2>/dev/null || echo '-')"
done

if [ -n "$MIRROR" ]; then
  say "Restoring the mirrored Garmin data and album-art cache (can take a few minutes)"
  [ -d "$MIRROR/HealthData" ] && rsync -rlt "$MIRROR/HealthData/" "$DEST/HealthData/"
  [ -d "$MIRROR/running-playlist-cache" ] && { mkdir -p "$APP/cache"; rsync -rlt "$MIRROR/running-playlist-cache/" "$APP/cache/"; }
else
  say "No --mirror given: HealthData is not restored (run garmin_run.py --all --download --import --analyze to refetch it)"
fi

if [ "$REAL" != 1 ]; then
  say "Rehearsal result"
  echo "app files:     $(find "$APP" -type f | wc -l)"
  echo "secrets file:  $([ -f "$APP/.env.local" ] && echo present || echo MISSING) (.env.local)"
  echo "crontab lines: $(grep -c . "$DEST/_backup/system/crontab.txt" || true)"
  echo "systemd unit:  $([ -f "$DEST/_backup/system/running-playlist.service" ] && echo present || echo MISSING)"
  echo "unpacked in $DEST; delete it with: rm -rf '$DEST'"
  exit 0
fi

say "Reinstalling the crontab and the systemd service"
crontab "$DEST/_backup/system/crontab.txt"
sudo cp "$DEST/_backup/system/running-playlist.service" /etc/systemd/system/running-playlist.service
sudo systemctl daemon-reload; sudo systemctl enable running-playlist

if [ ! -x "$HOME/garmindb-venv/bin/pip" ]; then
  say "Recreating the GarminDB virtualenv"
  python3 -m venv "$HOME/garmindb-venv"
  "$HOME/garmindb-venv/bin/pip" install -r "$DEST/_backup/system/garmindb-requirements.txt"
fi

if [ "$SKIP_BUILD" != 1 ]; then
  say "Rebuilding the app (npm ci && npm run build)"
  (cd "$APP" && npm ci && npm run build)
fi

if [ -f "$HOME/nginx-proxy-manager/docker-compose.yml" ]; then
  say "Starting the reverse proxy"
  (cd "$HOME/nginx-proxy-manager" && { sudo docker compose up -d 2>/dev/null || sudo docker-compose up -d; })
fi

say "Starting PaceSync"
sudo systemctl start running-playlist
sleep 5; systemctl is-active running-playlist && echo "PaceSync is running on port 5005"
echo "Restore finished. The unpacked backup info is in $DEST/_backup (safe to delete)."
