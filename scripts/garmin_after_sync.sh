#!/bin/bash
# Runs after every GarminDB sync (scheduled, manual, or triggered): has the
# app read the new runs' laps, weather and HRV into its own store so the
# Coach has them ready. Called by garmin_notify.sh and by the app's own
# sync routes.
app_dir="$(dirname "$0")/.."
secret=$(grep -E '^CRON_SECRET=' "$app_dir/.env.local" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"'\r')
[ -z "$secret" ] && exit 0
curl -s -m 280 -X POST http://localhost:5005/api/coach/refresh-data \
  -H "X-Cron-Secret: $secret" >/dev/null
exit 0
