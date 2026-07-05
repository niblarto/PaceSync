#!/bin/bash
# Push an ntfy notification after the Garmin sync cron finishes.
# The crontab garmin line calls this with the sync's exit status:
#   .../garmin_run.py --all ...; .../scripts/garmin_notify.sh $?
# Deployed and hooked into the crontab by deploy.py.
status=$1
config="$(dirname "$0")/../ntfy-config.json"
topic=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('topic',''))" "$config" 2>/dev/null)
[ -z "$topic" ] && exit 0
if [ "$status" = "0" ]; then
  title="Garmin sync finished"; tags="white_check_mark"; msg="Daily GarminDB sync completed OK"
else
  title="Garmin sync FAILED"; tags="x"; msg="GarminDB sync exited with status $status"
fi
curl -s -X POST https://ntfy.sh -H 'Content-Type: application/json' \
  -d "{\"topic\":\"$topic\",\"title\":\"$title\",\"message\":\"$msg\",\"tags\":[\"$tags\"]}" >/dev/null
