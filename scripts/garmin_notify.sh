#!/bin/bash
# Reports the Garmin sync cron's result to ntfy + the Android app, via the
# app's /api/cron/notify route (lib/cron-notify.ts sends both).
# The crontab garmin line calls this with the sync's exit status:
#   .../garmin_run.py --all ...; .../scripts/garmin_notify.sh $?
# Deployed and hooked into the crontab by deploy.py.
status=$1
app_dir="$(dirname "$0")/.."
secret=$(grep -E '^CRON_SECRET=' "$app_dir/.env.local" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"'\r')
[ -z "$secret" ] && exit 0
if [ "$status" = "0" ]; then
  body='{"title":"✅ Garmin sync finished","message":"Daily GarminDB sync completed OK","type":"garmin","tags":"white_check_mark","priority":"low"}'
else
  body="{\"title\":\"❌ Garmin sync FAILED\",\"message\":\"GarminDB sync exited with status $status\",\"type\":\"sync-error\",\"tags\":\"x\",\"priority\":\"high\"}"
fi
curl -s -X POST http://localhost:5005/api/cron/notify \
  -H 'Content-Type: application/json' -H "X-Cron-Secret: $secret" \
  -d "$body" >/dev/null
