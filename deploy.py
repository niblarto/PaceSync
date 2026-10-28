"""Deploy PaceSync Running Playlist to a Raspberry Pi.

Before deploying:
  1. Copy deploy_config.example.py to deploy_config.py and fill in your Pi details.
  2. Ensure .env.local is filled in with all credentials (see .env.example).
  3. In Spotify dashboard, add redirect URI: {NEXTAUTH_URL}/api/auth/callback/spotify
"""

import hashlib
import json
import paramiko
import time
import os
import sys

RUNNING_DIR = os.path.dirname(os.path.abspath(__file__))

# ── Load deploy config (Pi credentials) ──────────────────────────────────────
try:
    from deploy_config import PI, PORT, PI_REMOTE  # type: ignore
except ImportError:
    print("ERROR: deploy.config.py not found.")
    print("  Copy deploy.config.example.py to deploy.config.py and fill in your Pi details.")
    sys.exit(1)

# ── Read secrets from .env.local ──────────────────────────────────────────────
def read_env_local() -> dict:
    env: dict = {}
    env_path = os.path.join(RUNNING_DIR, '.env.local')
    try:
        with open(env_path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k, v = line.split('=', 1)
                    env[k.strip()] = v.strip()
    except FileNotFoundError:
        print("ERROR: .env.local not found. Copy .env.example to .env.local and fill it in.")
        sys.exit(1)
    return env

env = read_env_local()
cron_secret  = env.get('CRON_SECRET', '')
nextauth_url = env.get('NEXTAUTH_URL', '')

if not cron_secret:
    print("ERROR: CRON_SECRET not set in .env.local")
    sys.exit(1)

# Last.fm key for AI_BPM song suggestions: sync from the Windows user env var
# into .env.local so the Pi's Next.js server (and its spawned python) sees it.
lastfm_key = env.get('LASTFM_API_KEY') or os.environ.get('LASTFM_API_KEY', '')
if lastfm_key and not env.get('LASTFM_API_KEY'):
    with open(os.path.join(RUNNING_DIR, '.env.local'), 'a', encoding='utf-8') as f:
        f.write(f'\nLASTFM_API_KEY={lastfm_key}\n')
    print('  Added LASTFM_API_KEY to .env.local')
if not lastfm_key:
    print('  WARNING: LASTFM_API_KEY not found — song suggestions will fall back to Deezer only')

# NOTE: android/ (the native companion app) is its OWN Gradle project with a
# separate build pipeline (./gradlew assembleDebug, run locally/in Android
# Studio) — it is never referenced here and must never be added to FILES.
# This script only ever deploys the Next.js backend to the Pi.
FILES = [
    ('package.json',                              'package.json'),
    ('instrumentation-node.ts',                    'instrumentation-node.ts'),
    ('instrumentation.ts',                         'instrumentation.ts'),
    ('next.config.mjs',                           'next.config.mjs'),
    ('tsconfig.json',                             'tsconfig.json'),
    ('tailwind.config.ts',                        'tailwind.config.ts'),
    ('postcss.config.mjs',                        'postcss.config.mjs'),
    ('app/globals.css',                           'app/globals.css'),
    ('app/layout.tsx',                            'app/layout.tsx'),
    ('app/page.tsx',                              'app/page.tsx'),
    ('app/dashboard/page.tsx',                    'app/dashboard/page.tsx'),
    ('app/mobile/page.tsx',                       'app/mobile/page.tsx'),
    ('app/mobile/route/[activityId]/page.tsx',    'app/mobile/route/[activityId]/page.tsx'),
    ('components/MobileRouteClient.tsx',          'components/MobileRouteClient.tsx'),
    ('components/NextRunPinned.tsx',              'components/NextRunPinned.tsx'),
    ('app/api/auth/[...nextauth]/route.ts',       'app/api/auth/[...nextauth]/route.ts'),
    ('app/api/spotify/playlists/route.ts',        'app/api/spotify/playlists/route.ts'),
    ('app/api/spotify/tracks/route.ts',           'app/api/spotify/tracks/route.ts'),
    ('app/api/spotify/create-playlist/route.ts',  'app/api/spotify/create-playlist/route.ts'),
    ('app/api/spotify/add-tracks/route.ts',       'app/api/spotify/add-tracks/route.ts'),
    ('app/api/spotify/proxy/route.ts',            'app/api/spotify/proxy/route.ts'),
    ('app/api/spotify/rate-limit-status/route.ts', 'app/api/spotify/rate-limit-status/route.ts'),
    ('app/api/save-default-playlist/route.ts',    'app/api/save-default-playlist/route.ts'),
    ('app/api/tracks/delete/route.ts',            'app/api/tracks/delete/route.ts'),
    ('app/api/tracks/add/route.ts',               'app/api/tracks/add/route.ts'),
    ('app/api/tracks/check-deleted/route.ts',     'app/api/tracks/check-deleted/route.ts'),
    ('app/api/tracks/fill-uris-from-workbook/route.ts', 'app/api/tracks/fill-uris-from-workbook/route.ts'),
    ('app/api/tracks/heal-from-workbook/route.ts', 'app/api/tracks/heal-from-workbook/route.ts'),
    ('app/api/tracks/uris/route.ts',               'app/api/tracks/uris/route.ts'),
    ('app/api/tracks/played-counts/route.ts',      'app/api/tracks/played-counts/route.ts'),
    ('app/api/tracks/update-features/route.ts',   'app/api/tracks/update-features/route.ts'),
    ('app/api/tracks/update-field/route.ts',      'app/api/tracks/update-field/route.ts'),
    ('app/api/tracks/import-bpm-csv/route.ts',    'app/api/tracks/import-bpm-csv/route.ts'),
    ('app/api/settings/heal-status/route.ts',     'app/api/settings/heal-status/route.ts'),
    ('app/api/settings/heal-now/route.ts',        'app/api/settings/heal-now/route.ts'),
    ('app/api/settings/heal-now-status/route.ts', 'app/api/settings/heal-now-status/route.ts'),
    ('app/api/settings/incomplete-tracks/route.ts', 'app/api/settings/incomplete-tracks/route.ts'),
    ('app/api/settings/heal-cancel/route.ts',     'app/api/settings/heal-cancel/route.ts'),
    ('app/api/settings/active-tracks/route.ts',   'app/api/settings/active-tracks/route.ts'),
    ('app/api/settings/duplicate-count/route.ts', 'app/api/settings/duplicate-count/route.ts'),
    ('app/api/settings/deleted-tracks/route.ts',  'app/api/settings/deleted-tracks/route.ts'),
    ('app/api/settings/library-coverage/route.ts', 'app/api/settings/library-coverage/route.ts'),
    ('app/api/tracks/copy-to-playlist/route.ts',  'app/api/tracks/copy-to-playlist/route.ts'),
    ('app/api/settings/register-playlist/route.ts', 'app/api/settings/register-playlist/route.ts'),
    ('lib/csv-merge.ts',                          'lib/csv-merge.ts'),
    ('lib/csv-store.ts',                          'lib/csv-store.ts'),
    ('lib/deleted-tracks.ts',                     'lib/deleted-tracks.ts'),
    ('lib/confirmed-unique-tracks.ts',             'lib/confirmed-unique-tracks.ts'),
    ('app/api/tracks/confirm-unique/route.ts',     'app/api/tracks/confirm-unique/route.ts'),
    ('lib/library-add.ts',                        'lib/library-add.ts'),
    ('lib/added-tracks.ts',                       'lib/added-tracks.ts'),
    ('app/api/tracks/recently-added/route.ts',    'app/api/tracks/recently-added/route.ts'),
    ('app/api/bbc/tracks/route.ts',               'app/api/bbc/tracks/route.ts'),
    ('app/api/bbc/episode-info/route.ts',         'app/api/bbc/episode-info/route.ts'),
    ('app/api/bbc/schedule/route.ts',             'app/api/bbc/schedule/route.ts'),
    ('app/api/bbc/programmes/route.ts',           'app/api/bbc/programmes/route.ts'),
    ('app/api/bbc/bpm-range/route.ts',            'app/api/bbc/bpm-range/route.ts'),
    ('app/api/bbc/reject-track/route.ts',          'app/api/bbc/reject-track/route.ts'),
    ('app/api/settings/bbc-bpm-filter/route.ts',  'app/api/settings/bbc-bpm-filter/route.ts'),
    ('lib/bbc-bpm-filter.ts',                     'lib/bbc-bpm-filter.ts'),
    ('lib/bbc-bpm-filter-config.ts',              'lib/bbc-bpm-filter-config.ts'),
    ('app/api/settings/dashboard-layout/route.ts', 'app/api/settings/dashboard-layout/route.ts'),
    ('lib/dashboard-layout-config.ts',            'lib/dashboard-layout-config.ts'),
    ('app/api/itunes-art/route.ts',               'app/api/itunes-art/route.ts'),
    ('app/api/spotify/playlist-uris/route.ts',    'app/api/spotify/playlist-uris/route.ts'),
    ('app/api/cron/weekly/route.ts',              'app/api/cron/weekly/route.ts'),
    ('app/api/cron/test/route.ts',                'app/api/cron/test/route.ts'),
    ('app/api/settings/hr-zones/route.ts',        'app/api/settings/hr-zones/route.ts'),
    ('app/api/settings/hr-zones/external/route.ts', 'app/api/settings/hr-zones/external/route.ts'),
    ('app/api/settings/runna-url/route.ts',       'app/api/settings/runna-url/route.ts'),
    ('app/api/settings/ntfy/route.ts',            'app/api/settings/ntfy/route.ts'),
    ('app/api/settings/garmin/route.ts',          'app/api/settings/garmin/route.ts'),
    ('app/api/settings/garmin/sync-status/route.ts', 'app/api/settings/garmin/sync-status/route.ts'),
    ('app/api/settings/llm-test/models/route.ts', 'app/api/settings/llm-test/models/route.ts'),
    ('app/api/settings/llm-test/status/route.ts', 'app/api/settings/llm-test/status/route.ts'),
    ('app/api/settings/llm-test/compare/route.ts', 'app/api/settings/llm-test/compare/route.ts'),
    ('app/api/garmin/data/route.ts',              'app/api/garmin/data/route.ts'),
    ('app/api/garmin/activity-title/route.ts',    'app/api/garmin/activity-title/route.ts'),
    ('app/api/garmin/pace-spm/route.ts',          'app/api/garmin/pace-spm/route.ts'),
    ('app/api/garmin/similar-activities/route.ts', 'app/api/garmin/similar-activities/route.ts'),
    ('app/api/garmin/route/[id]/route.ts',        'app/api/garmin/route/[id]/route.ts'),
    ('components/RouteMapLightbox.tsx',           'components/RouteMapLightbox.tsx'),
    ('lib/route-graph.ts',                        'lib/route-graph.ts'),
    ('app/api/garmin/route-suggestions/route.ts', 'app/api/garmin/route-suggestions/route.ts'),
    ('app/api/settings/route-home/route.ts',     'app/api/settings/route-home/route.ts'),
    ('lib/route-excluded.ts',                     'lib/route-excluded.ts'),
    ('app/api/settings/route-excluded/route.ts',  'app/api/settings/route-excluded/route.ts'),
    ('app/api/garmin/route-through/route.ts',    'app/api/garmin/route-through/route.ts'),
    ('lib/ors.ts',                                'lib/ors.ts'),
    ('lib/route-score.ts',                        'lib/route-score.ts'),
    ('app/api/settings/route-ors-key/route.ts',   'app/api/settings/route-ors-key/route.ts'),
    ('components/OrsKeyCard.tsx',                 'components/OrsKeyCard.tsx'),
    ('lib/route-finish.ts',                       'lib/route-finish.ts'),
    ('app/api/garmin/route-explore/route.ts',     'app/api/garmin/route-explore/route.ts'),
    ('lib/route-graph-cache.ts',                  'lib/route-graph-cache.ts'),
    ('app/api/garmin/route-point/route.ts',       'app/api/garmin/route-point/route.ts'),
    ('lib/saved-routes.ts',                       'lib/saved-routes.ts'),
    ('app/api/garmin/saved-routes/route.ts',      'app/api/garmin/saved-routes/route.ts'),
    ('lib/coach-brief.ts',                        'lib/coach-brief.ts'),
    ('app/api/coach/brief/route.ts',              'app/api/coach/brief/route.ts'),
    ('app/api/cron/coach-brief/route.ts',         'app/api/cron/coach-brief/route.ts'),
    ('components/BriefBullets.tsx',               'components/BriefBullets.tsx'),
    ('components/FortnightFacts.tsx',              'components/FortnightFacts.tsx'),
    ('components/ScheduleBriefPanel.tsx',          'components/ScheduleBriefPanel.tsx'),
    ('app/api/coach/fortnight/route.ts',           'app/api/coach/fortnight/route.ts'),
    ('lib/training-readiness.ts',                 'lib/training-readiness.ts'),
    ('app/api/garmin/training-readiness/route.ts', 'app/api/garmin/training-readiness/route.ts'),
    ('components/TrainingReadinessLine.tsx',      'components/TrainingReadinessLine.tsx'),
    ('lib/body-battery.ts',                       'lib/body-battery.ts'),
    ('app/api/garmin/body-battery/route.ts',      'app/api/garmin/body-battery/route.ts'),
    ('components/BodyBatteryLine.tsx',            'components/BodyBatteryLine.tsx'),
    ('app/routes/page.tsx',                      'app/routes/page.tsx'),
    ('components/RoutePlannerClient.tsx',         'components/RoutePlannerClient.tsx'),
    ('hooks/useRouteMap.ts',                      'hooks/useRouteMap.ts'),
    ('app/garmin/page.tsx',                       'app/garmin/page.tsx'),
    ('app/pace-pro/page.tsx',                     'app/pace-pro/page.tsx'),
    ('components/PaceProClient.tsx',              'components/PaceProClient.tsx'),
    ('app/races/page.tsx',                        'app/races/page.tsx'),
    ('components/RacesClient.tsx',                'components/RacesClient.tsx'),
    ('app/coach/page.tsx',                        'app/coach/page.tsx'),
    ('components/CoachClient.tsx',                'components/CoachClient.tsx'),
    ('app/api/coach/chat/route.ts',               'app/api/coach/chat/route.ts'),
    ('app/api/coach/session/route.ts',            'app/api/coach/session/route.ts'),
    ('app/api/coach/context/route.ts',            'app/api/coach/context/route.ts'),
    ('app/api/settings/coach/route.ts',           'app/api/settings/coach/route.ts'),
    ('lib/coach-config.ts',                       'lib/coach-config.ts'),
    ('lib/coach-llm.ts',                          'lib/coach-llm.ts'),
    ('lib/coach-context.ts',                      'lib/coach-context.ts'),
    ('lib/coach-store.ts',                        'lib/coach-store.ts'),
    ('lib/coach-prompt.ts',                       'lib/coach-prompt.ts'),
    ('lib/coach-memory.ts',                       'lib/coach-memory.ts'),
    ('lib/coach-session.ts',                      'lib/coach-session.ts'),
    ('app/api/coach/memory/route.ts',             'app/api/coach/memory/route.ts'),
    ('lib/run-feedback.ts',                       'lib/run-feedback.ts'),
    ('app/api/run-feedback/route.ts',             'app/api/run-feedback/route.ts'),
    ('components/RunFeedbackPanel.tsx',           'components/RunFeedbackPanel.tsx'),
    ('lib/garmin-personal-api.ts',                'lib/garmin-personal-api.ts'),
    ('app/api/settings/garmin-personal-api/route.ts', 'app/api/settings/garmin-personal-api/route.ts'),
    ('components/GarminPersonalApiCard.tsx',      'components/GarminPersonalApiCard.tsx'),
    ('lib/coach-garmin-extra.ts',                 'lib/coach-garmin-extra.ts'),
    ('scripts/fit_laps.py',                       'scripts/fit_laps.py'),
    ('scripts/garmin_after_sync.sh',              'scripts/garmin_after_sync.sh'),
    ('scripts/pacesync_backup.py',                'scripts/pacesync_backup.py'),
    ('scripts/pacesync_restore.sh',               'scripts/pacesync_restore.sh'),
    ('app/api/coach/refresh-data/route.ts',       'app/api/coach/refresh-data/route.ts'),
    ('lib/coach-weekly.ts',                       'lib/coach-weekly.ts'),
    ('lib/coach-format.ts', 'lib/coach-format.ts'),
    ('lib/garmin-connect.ts', 'lib/garmin-connect.ts'),
    ('lib/web-search.ts', 'lib/web-search.ts'),
    ('app/api/settings/web-search/route.ts', 'app/api/settings/web-search/route.ts'),
    ('app/api/cron/coach-weekly/route.ts',        'app/api/cron/coach-weekly/route.ts'),
    ('app/api/coach/reports/route.ts',            'app/api/coach/reports/route.ts'),
    ('components/CoachSettingsCard.tsx',          'components/CoachSettingsCard.tsx'),
    ('lib/nutrition.ts',                          'lib/nutrition.ts'),
    ('app/api/nutrition/route.ts',                'app/api/nutrition/route.ts'),
    ('app/api/nutrition/dashboard/route.ts', 'app/api/nutrition/dashboard/route.ts'),
    ('app/api/settings/nutrition/route.ts', 'app/api/settings/nutrition/route.ts'),
    ('app/nutrition/page.tsx', 'app/nutrition/page.tsx'),
    ('components/NutritionClient.tsx', 'components/NutritionClient.tsx'),
    ('components/NutritionSettingsCard.tsx', 'components/NutritionSettingsCard.tsx'),
    ('lib/nutrition-config.ts', 'lib/nutrition-config.ts'),
    ('lib/nutrition-dashboard.ts', 'lib/nutrition-dashboard.ts'),
    ('lib/weight-format.ts', 'lib/weight-format.ts'),
    ('lib/nutrition-summary.ts', 'lib/nutrition-summary.ts'),
    ('lib/garmin-weight.ts', 'lib/garmin-weight.ts'),
    ('app/api/nutrition/weight-refresh/route.ts', 'app/api/nutrition/weight-refresh/route.ts'),
    ('app/api/cron/garmin-weight/route.ts', 'app/api/cron/garmin-weight/route.ts'),
    ('app/api/nutrition/summary/route.ts', 'app/api/nutrition/summary/route.ts'),
    ('app/api/cron/nutrition-summary/route.ts', 'app/api/cron/nutrition-summary/route.ts'),
    ('lib/loseit-gwt.ts', 'lib/loseit-gwt.ts'),
    ('lib/loseit-session.ts', 'lib/loseit-session.ts'),
    ('lib/loseit-export.ts', 'lib/loseit-export.ts'),
    ('lib/loseit-food.ts', 'lib/loseit-food.ts'),
    ('app/api/settings/loseit/route.ts', 'app/api/settings/loseit/route.ts'),
    ('app/api/loseit/diary/route.ts', 'app/api/loseit/diary/route.ts'),
    ('app/api/loseit/sync/route.ts', 'app/api/loseit/sync/route.ts'),
    ('app/api/cron/loseit/route.ts', 'app/api/cron/loseit/route.ts'),
    ('app/api/loseit/search/route.ts', 'app/api/loseit/search/route.ts'),
    ('app/api/loseit/food/route.ts', 'app/api/loseit/food/route.ts'),
    ('app/api/loseit/log/route.ts', 'app/api/loseit/log/route.ts'),
    ('app/api/loseit/copy/route.ts', 'app/api/loseit/copy/route.ts'),
    ('app/api/loseit/move/route.ts', 'app/api/loseit/move/route.ts'),
    ('app/api/loseit/icon/route.ts', 'app/api/loseit/icon/route.ts'),
    ('lib/loseit-icons.ts', 'lib/loseit-icons.ts'),
    ('components/LoseItSettingsCard.tsx', 'components/LoseItSettingsCard.tsx'),
    ('components/BackupSettingsCard.tsx', 'components/BackupSettingsCard.tsx'),
    ('app/api/loseit/edit/route.ts', 'app/api/loseit/edit/route.ts'),
    ('lib/backup-settings.ts', 'lib/backup-settings.ts'),
    ('app/api/settings/backup/route.ts', 'app/api/settings/backup/route.ts'),
    ('components/FoodDiaryPanel.tsx', 'components/FoodDiaryPanel.tsx'),
    ('app/races/[id]/page.tsx',                    'app/races/[id]/page.tsx'),
    ('components/RaceDetailClient.tsx',           'components/RaceDetailClient.tsx'),
    ('components/InlineRouteMap.tsx',             'components/InlineRouteMap.tsx'),
    ('app/api/races/route.ts',                    'app/api/races/route.ts'),
    ('app/api/races/[id]/route.ts',                'app/api/races/[id]/route.ts'),
    ('lib/races.ts',                              'lib/races.ts'),
    ('app/garmin/activity/[id]/page.tsx',         'app/garmin/activity/[id]/page.tsx'),
    ('app/api/garmin/activity/[id]/route.ts',     'app/api/garmin/activity/[id]/route.ts'),
    ('components/GarminClient.tsx',               'components/GarminClient.tsx'),
    ('components/GarminActivityClient.tsx',       'components/GarminActivityClient.tsx'),
    ('components/MixPaceChart.tsx',               'components/MixPaceChart.tsx'),
    ('components/SongProgressBar.tsx',            'components/SongProgressBar.tsx'),
    ('components/ArtistListInput.tsx',            'components/ArtistListInput.tsx'),
    ('components/MixChartClient.tsx',             'components/MixChartClient.tsx'),
    ('app/mix/[date]/page.tsx',                   'app/mix/[date]/page.tsx'),
    ('lib/garmin-config.ts',                      'lib/garmin-config.ts'),
    ('lib/garmin-activity-titles.ts',              'lib/garmin-activity-titles.ts'),
    ('lib/db.ts',                                  'lib/db.ts'),
    ('app/api/runna/workouts/route.ts',           'app/api/runna/workouts/route.ts'),
    ('app/api/runna/workout-segments/route.ts',   'app/api/runna/workout-segments/route.ts'),
    ('components/RunnaCard.tsx',                  'components/RunnaCard.tsx'),
    ('components/AdvancedMixModal.tsx',           'components/AdvancedMixModal.tsx'),
    ('components/RunDetailClient.tsx',             'components/RunDetailClient.tsx'),
    ('app/run/[date]/page.tsx',                   'app/run/[date]/page.tsx'),
    ('lib/track-delete-client.ts',                'lib/track-delete-client.ts'),
    ('app/settings/page.tsx',                     'app/settings/page.tsx'),
    ('app/settings/SettingsClient.tsx',           'app/settings/SettingsClient.tsx'),
    ('lib/tokenStore.ts',                         'lib/tokenStore.ts'),
    ('lib/runna-config.ts',                       'lib/runna-config.ts'),
    ('lib/ntfy-config.ts',                        'lib/ntfy-config.ts'),
    ('lib/ntfy.ts',                               'lib/ntfy.ts'),
    ('lib/strava-config.ts',                      'lib/strava-config.ts'),
    ('lib/metoffice-config.ts',                   'lib/metoffice-config.ts'),
    ('lib/discogs-config.ts',                     'lib/discogs-config.ts'),
    ('lib/discogs-genre-map.ts',                  'lib/discogs-genre-map.ts'),
    ('lib/discogs-artist-search.ts',              'lib/discogs-artist-search.ts'),
    ('lib/spotify-browser.ts',                    'lib/spotify-browser.ts'),
    ('lib/strava-tokens.ts',                      'lib/strava-tokens.ts'),
    ('lib/strava.ts',                             'lib/strava.ts'),
    ('lib/strava-workout-sync.ts',                'lib/strava-workout-sync.ts'),
    ('app/api/strava/connect/route.ts',           'app/api/strava/connect/route.ts'),
    ('app/api/strava/callback/route.ts',          'app/api/strava/callback/route.ts'),
    ('app/api/strava/stats/route.ts',             'app/api/strava/stats/route.ts'),
    ('app/api/strava/webhook/route.ts',           'app/api/strava/webhook/route.ts'),
    ('app/api/strava/webhook/subscribe/route.ts', 'app/api/strava/webhook/subscribe/route.ts'),
    ('app/api/strava/sync-title/route.ts',        'app/api/strava/sync-title/route.ts'),
    ('app/api/settings/strava/route.ts',          'app/api/settings/strava/route.ts'),
    ('app/api/settings/metoffice/route.ts',       'app/api/settings/metoffice/route.ts'),
    ('app/api/settings/discogs-key/route.ts',     'app/api/settings/discogs-key/route.ts'),
    ('app/api/weather/route.ts',                  'app/api/weather/route.ts'),
    ('app/api/garmin/auto-sync/route.ts',         'app/api/garmin/auto-sync/route.ts'),
    ('app/api/garmin/courses/route.ts',           'app/api/garmin/courses/route.ts'),
    ('app/api/garmin/course-route/[courseId]/route.ts', 'app/api/garmin/course-route/[courseId]/route.ts'),
    ('app/api/garmin/activity-for-date/route.ts', 'app/api/garmin/activity-for-date/route.ts'),
    ('app/strava/page.tsx',                       'app/strava/page.tsx'),
    ('components/StravaClient.tsx',               'components/StravaClient.tsx'),
    ('public/Running.csv',                        'public/Running.csv'),
    ('public/favicon.svg',                        'public/favicon.svg'),
    ('public/cd-art/cd-1.jpg',                    'public/cd-art/cd-1.jpg'),
    ('public/cd-art/cd-2.jpg',                    'public/cd-art/cd-2.jpg'),
    ('public/cd-art/cd-3.jpg',                    'public/cd-art/cd-3.jpg'),
    ('public/cd-art/cd-4.jpg',                    'public/cd-art/cd-4.jpg'),
    ('public/settings-hero.png',                  'public/settings-hero.png'),
    ('public/hero.png',                            'public/hero.png'),
    ('public/dashboard-hero.png',                  'public/dashboard-hero.png'),
    ('components/AuthProvider.tsx',               'components/AuthProvider.tsx'),
    ('components/BbcPlaylistCard.tsx',            'components/BbcPlaylistCard.tsx'),
    ('components/DeletedTracksReview.tsx',        'components/DeletedTracksReview.tsx'),
    ('components/BbcBrowserCard.tsx',             'components/BbcBrowserCard.tsx'),
    ('components/BbcRadioClient.tsx',             'components/BbcRadioClient.tsx'),
    ('app/bbc/page.tsx',                          'app/bbc/page.tsx'),
    ('components/DedupCard.tsx',                  'components/DedupCard.tsx'),
    ('components/GenreExplorer.tsx',              'components/GenreExplorer.tsx'),
    ('components/ImportLookupCsvPanel.tsx',       'components/ImportLookupCsvPanel.tsx'),
    ('components/SpotifyRateLimitBanner.tsx',     'components/SpotifyRateLimitBanner.tsx'),
    ('components/DuplicateTracksBanner.tsx',      'components/DuplicateTracksBanner.tsx'),
    ('components/MissingDataBanner.tsx',          'components/MissingDataBanner.tsx'),
    ('components/DashboardClient.tsx',            'components/DashboardClient.tsx'),
    ('components/MobileDashboardClient.tsx',      'components/MobileDashboardClient.tsx'),
    ('components/SignInButton.tsx',               'components/SignInButton.tsx'),
    ('components/TrackRow.tsx',                   'components/TrackRow.tsx'),
    ('components/FloatingCard.tsx',               'components/FloatingCard.tsx'),
    ('components/ZoneCard.tsx',                   'components/ZoneCard.tsx'),
    ('lib/auth.ts',                               'lib/auth.ts'),
    ('lib/itunes-art.ts',                         'lib/itunes-art.ts'),
    ('lib/bpm-zones.ts',                          'lib/bpm-zones.ts'),
    ('lib/spotify.ts',                            'lib/spotify.ts'),
    ('lib/garmin-cache.ts',                       'lib/garmin-cache.ts'),
    ('types/index.ts',                            'types/index.ts'),
    ('types/next-auth.d.ts',                      'types/next-auth.d.ts'),
    # AI_BPM song matcher (vendored into this repo under bpm_matcher/)
    ('app/api/bpm/similar/route.ts',              'app/api/bpm/similar/route.ts'),
    ('app/api/bpm/suggest/route.ts',              'app/api/bpm/suggest/route.ts'),
    ('app/api/bpm/enrich/route.ts',               'app/api/bpm/enrich/route.ts'),
    ('app/api/bpm/artist-top/route.ts',           'app/api/bpm/artist-top/route.ts'),
    ('lib/deezer-artist-top.ts',                  'lib/deezer-artist-top.ts'),
    ('lib/deezer-bpm-crawl.ts',                   'lib/deezer-bpm-crawl.ts'),
    ('app/api/tracks/replace-candidates/route.ts', 'app/api/tracks/replace-candidates/route.ts'),
    ('app/api/tracks/genres/route.ts',             'app/api/tracks/genres/route.ts'),
    ('app/api/tracks/genre-uris/route.ts',         'app/api/tracks/genre-uris/route.ts'),
    ('app/api/tracks/move-genre/route.ts',         'app/api/tracks/move-genre/route.ts'),
    ('app/api/tracks/set-unknown-genre/route.ts',  'app/api/tracks/set-unknown-genre/route.ts'),
    ('app/api/tracks/replace-candidates-budget/route.ts', 'app/api/tracks/replace-candidates-budget/route.ts'),
    ('app/api/tracks/song-crawler/route.ts',     'app/api/tracks/song-crawler/route.ts'),
    ('lib/song-crawler.ts',                        'lib/song-crawler.ts'),
    ('lib/bpm-spec.ts',                            'lib/bpm-spec.ts'),
    ('lib/artist-list.ts',                         'lib/artist-list.ts'),
    ('lib/review-playlist.ts',                     'lib/review-playlist.ts'),
    ('lib/spotify-governor.ts',                    'lib/spotify-governor.ts'),
    ('lib/spotify-outbox.ts',                      'lib/spotify-outbox.ts'),
    ('lib/favourite-tracks.ts',                    'lib/favourite-tracks.ts'),
    ('app/api/tracks/favourites/route.ts',         'app/api/tracks/favourites/route.ts'),
    ('lib/queued-message.ts',                      'lib/queued-message.ts'),
    ('lib/wip-playlist.ts',                        'lib/wip-playlist.ts'),
    ('app/api/spotify/wip/route.ts',               'app/api/spotify/wip/route.ts'),
    ('app/api/cron/wip-cleanup/route.ts',          'app/api/cron/wip-cleanup/route.ts'),
    ('lib/system-status.ts',                       'lib/system-status.ts'),
    ('app/api/settings/status/route.ts',           'app/api/settings/status/route.ts'),
    ('app/api/settings/status/logs/route.ts',      'app/api/settings/status/logs/route.ts'),
    ('components/TopNav.tsx',                      'components/TopNav.tsx'),
    ('components/useFavourites.ts',                'components/useFavourites.ts'),
    ('components/usePlaylistAdvance.ts',           'components/usePlaylistAdvance.ts'),
    ('components/StatusTab.tsx',                   'components/StatusTab.tsx'),
    ('lib/spotify-lookup-account.ts',              'lib/spotify-lookup-account.ts'),
    ('app/api/spotify-lookup-account/login/route.ts', 'app/api/spotify-lookup-account/login/route.ts'),
    ('app/api/spotify-app2/callback/route.ts',     'app/api/spotify-app2/callback/route.ts'),
    ('app/api/spotify-lookup-account/status/route.ts', 'app/api/spotify-lookup-account/status/route.ts'),
    ('app/api/spotify/lookup-tracks/route.ts',      'app/api/spotify/lookup-tracks/route.ts'),
    ('components/LookupAccountCard.tsx',            'components/LookupAccountCard.tsx'),
    ('lib/crawled-artists.ts',                     'lib/crawled-artists.ts'),
    ('app/api/tracks/song-crawler/artists/route.ts', 'app/api/tracks/song-crawler/artists/route.ts'),
    ('lib/crawler-inputs.ts',                      'lib/crawler-inputs.ts'),
    ('app/api/tracks/song-crawler/inputs/route.ts', 'app/api/tracks/song-crawler/inputs/route.ts'),
    ('lib/spotify-removals.ts',                    'lib/spotify-removals.ts'),
    ('lib/crawler-lookup-client.ts',               'lib/crawler-lookup-client.ts'),
    ('components/SongCrawlerClient.tsx',           'components/SongCrawlerClient.tsx'),
    ('app/crawler/page.tsx',                       'app/crawler/page.tsx'),
    ('app/api/tracks/artists/route.ts',            'app/api/tracks/artists/route.ts'),
    ('lib/library-delete.ts',                      'lib/library-delete.ts'),
    ('lib/rest-day-mix.ts',                        'lib/rest-day-mix.ts'),
    ('lib/rest-day-mix-shared.ts',                 'lib/rest-day-mix-shared.ts'),
    ('app/api/tracks/lookup/route.ts',           'app/api/tracks/lookup/route.ts'),
    ('lib/track-lookup.ts',                        'lib/track-lookup.ts'),
    ('app/api/tracks/lookup-list/route.ts',        'app/api/tracks/lookup-list/route.ts'),
    ('app/api/tracks/lookup-fit/route.ts',         'app/api/tracks/lookup-fit/route.ts'),
    ('lib/fit-budget.ts',                          'lib/fit-budget.ts'),
    ('lib/genre-artists.ts',                       'lib/genre-artists.ts'),
    ('lib/genre-hierarchy.ts',                     'lib/genre-hierarchy.ts'),
    ('lib/energy-bands.ts',                        'lib/energy-bands.ts'),
    ('app/api/tracks/genres-artists/route.ts',     'app/api/tracks/genres-artists/route.ts'),
    ('app/api/ai-dj/mix/route.ts',                'app/api/ai-dj/mix/route.ts'),
    ('app/api/ai-dj/segment-defaults/route.ts',   'app/api/ai-dj/segment-defaults/route.ts'),
    ('app/api/ai-dj/remix/route.ts',              'app/api/ai-dj/remix/route.ts'),
    ('app/api/ai-dj/simulate-mix/route.ts',       'app/api/ai-dj/simulate-mix/route.ts'),
    ('app/api/ai-dj/flow-mix/route.ts',           'app/api/ai-dj/flow-mix/route.ts'),
    ('app/api/ai-dj/health/route.ts',             'app/api/ai-dj/health/route.ts'),
    ('app/api/ai-dj/wake/route.ts',               'app/api/ai-dj/wake/route.ts'),
    ('app/api/ai-dj/pin/route.ts',                'app/api/ai-dj/pin/route.ts'),
    ('app/api/spotify/play/route.ts',             'app/api/spotify/play/route.ts'),
    ('app/api/spotify/playback/route.ts',         'app/api/spotify/playback/route.ts'),
    ('app/api/ai-dj/race-splits/route.ts',        'app/api/ai-dj/race-splits/route.ts'),
    ('app/api/ai-dj/race-splits/link-pace-pro/route.ts', 'app/api/ai-dj/race-splits/link-pace-pro/route.ts'),
    ('lib/race-splits.ts',                        'lib/race-splits.ts'),
    ('lib/pace-pro.ts',                            'lib/pace-pro.ts'),
    ('lib/pace-pro-pin.ts',                        'lib/pace-pro-pin.ts'),
    ('lib/pace-pro-saved.ts',                      'lib/pace-pro-saved.ts'),
    ('lib/workout-title-cache.ts',                 'lib/workout-title-cache.ts'),
    ('app/api/settings/pace-pro-saved/route.ts',   'app/api/settings/pace-pro-saved/route.ts'),
    ('app/api/settings/pace-pro-saved/activity/route.ts', 'app/api/settings/pace-pro-saved/activity/route.ts'),
    ('app/api/settings/pace-pro-saved/duplicate/route.ts', 'app/api/settings/pace-pro-saved/duplicate/route.ts'),
    ('app/api/settings/pace-pro-saved/rename/route.ts', 'app/api/settings/pace-pro-saved/rename/route.ts'),
    ('app/api/settings/pace-pro-saved/spotify/route.ts', 'app/api/settings/pace-pro-saved/spotify/route.ts'),
    ('lib/pace-analysis.ts',                       'lib/pace-analysis.ts'),
    ('app/api/settings/pace-analysis/route.ts',    'app/api/settings/pace-analysis/route.ts'),
    ('app/api/settings/pace-analysis-batch/route.ts', 'app/api/settings/pace-analysis-batch/route.ts'),
    ('app/api/settings/bpm-pace-chart/route.ts',    'app/api/settings/bpm-pace-chart/route.ts'),
    ('app/api/settings/pace-pro-image/route.ts',    'app/api/settings/pace-pro-image/route.ts'),
    ('app/api/settings/race-splits-image/route.ts', 'app/api/settings/race-splits-image/route.ts'),
    ('app/api/settings/pace-pro-pin/route.ts',     'app/api/settings/pace-pro-pin/route.ts'),
    ('app/api/ai-dj/candidates/route.ts',         'app/api/ai-dj/candidates/route.ts'),
    ('lib/mix-candidates.ts',                     'lib/mix-candidates.ts'),
    ('app/api/ai-dj/removed-tracks/route.ts',     'app/api/ai-dj/removed-tracks/route.ts'),
    ('lib/removed-tracks.ts',                     'lib/removed-tracks.ts'),
    ('app/api/garmin/pin-route/route.ts',          'app/api/garmin/pin-route/route.ts'),
    ('lib/workout-key.ts',                        'lib/workout-key.ts'),
    ('lib/pinned-routes.ts',                       'lib/pinned-routes.ts'),
    ('lib/pinned-mixes.ts',                       'lib/pinned-mixes.ts'),
    ('app/api/settings/bpm-overrides/route.ts',   'app/api/settings/bpm-overrides/route.ts'),
    ('app/api/settings/pace-bpm-suggestions/route.ts', 'app/api/settings/pace-bpm-suggestions/route.ts'),
    ('lib/bpm-overrides.ts',                      'lib/bpm-overrides.ts'),
    ('lib/bpm-track-overrides.ts',                'lib/bpm-track-overrides.ts'),
    ('app/api/tracks/bpm-override/route.ts',      'app/api/tracks/bpm-override/route.ts'),
    ('app/api/settings/ai-dj/route.ts',           'app/api/settings/ai-dj/route.ts'),
    ('app/api/settings/ai-dj/claude-key/route.ts', 'app/api/settings/ai-dj/claude-key/route.ts'),
    ('app/api/settings/ai-dj/gemini-key/route.ts', 'app/api/settings/ai-dj/gemini-key/route.ts'),
    ('app/api/settings/ai-dj/usage/route.ts',     'app/api/settings/ai-dj/usage/route.ts'),
    ('app/api/settings/ai-dj/llm-log/route.ts',   'app/api/settings/ai-dj/llm-log/route.ts'),
    ('app/api/cron/ai-dj/route.ts',               'app/api/cron/ai-dj/route.ts'),
    ('app/api/cron/ai-dj-retry/route.ts',          'app/api/cron/ai-dj-retry/route.ts'),
    ('app/api/cron/digest/route.ts',               'app/api/cron/digest/route.ts'),
    ('app/api/cron/library-sync/route.ts',         'app/api/cron/library-sync/route.ts'),
    ('app/api/cron/notify/route.ts',               'app/api/cron/notify/route.ts'),
    ('app/api/cron/heal/route.ts',                 'app/api/cron/heal/route.ts'),
    ('app/api/cron/broken-tracklists/route.ts',    'app/api/cron/broken-tracklists/route.ts'),
    ('app/api/tracklists/broken/route.ts',         'app/api/tracklists/broken/route.ts'),
    ('lib/broken-tracklists.ts',                   'lib/broken-tracklists.ts'),
    ('components/useBrokenTracklists.ts',          'components/useBrokenTracklists.ts'),
    ('components/BrokenTracklistsBanner.tsx',      'components/BrokenTracklistsBanner.tsx'),
    ('lib/cron-notify.ts',                         'lib/cron-notify.ts'),
    ('lib/spotify-library-sync.ts',                'lib/spotify-library-sync.ts'),
    ('lib/cron-schedule.ts',                      'lib/cron-schedule.ts'),
    ('lib/cron-log.ts',                           'lib/cron-log.ts'),
    ('lib/todays-run-history.ts',                 'lib/todays-run-history.ts'),
    ('lib/play-counts.ts',                        'lib/play-counts.ts'),
    ('lib/recent-mix-builds.ts',                   'lib/recent-mix-builds.ts'),
    ('lib/run-pace-bias.ts',                      'lib/run-pace-bias.ts'),
    ('lib/track-feedback.ts',                     'lib/track-feedback.ts'),
    ('lib/running-playlist-config.ts',            'lib/running-playlist-config.ts'),
    ('lib/tracks-store.ts',                        'lib/tracks-store.ts'),
    ('types/track.ts',                             'types/track.ts'),
    ('app/api/settings/playlist/route.ts',        'app/api/settings/playlist/route.ts'),
    ('app/api/settings/playlists/route.ts',       'app/api/settings/playlists/route.ts'),
    ('app/api/settings/playlists/download/route.ts', 'app/api/settings/playlists/download/route.ts'),
    ('app/api/settings/playlists/delete-missing-uris/route.ts', 'app/api/settings/playlists/delete-missing-uris/route.ts'),
    ('app/api/settings/playlists/export-missing-uris/route.ts', 'app/api/settings/playlists/export-missing-uris/route.ts'),
    ('app/api/playlist-csv/route.ts',             'app/api/playlist-csv/route.ts'),
    ('app/api/ai-dj-library/lookup/route.ts',     'app/api/ai-dj-library/lookup/route.ts'),
    ('components/useRunningPlaylist.ts',          'components/useRunningPlaylist.ts'),
    ('app/api/track-feedback/route.ts',           'app/api/track-feedback/route.ts'),
    ('app/api/todays-run/history/route.ts',       'app/api/todays-run/history/route.ts'),
    ('app/api/garmin/run-pacing/route.ts',        'app/api/garmin/run-pacing/route.ts'),
    ('app/api/settings/cron/route.ts',            'app/api/settings/cron/route.ts'),
    # Local login + 2FA gate in front of Spotify OAuth
    ('middleware.ts',                             'middleware.ts'),
    ('lib/local-auth.ts',                         'lib/local-auth.ts'),
    ('app/login/page.tsx',                        'app/login/page.tsx'),
    ('app/login/LoginClient.tsx',                 'app/login/LoginClient.tsx'),
    ('app/api/local-auth/login/route.ts',         'app/api/local-auth/login/route.ts'),
    ('app/api/local-auth/status/route.ts',        'app/api/local-auth/status/route.ts'),
    ('app/api/local-auth/logout/route.ts',        'app/api/local-auth/logout/route.ts'),
    ('app/api/local-auth/totp/route.ts',          'app/api/local-auth/totp/route.ts'),
    ('local-auth.json',                           'local-auth.json'),
    # Android companion app — bearer-token auth for JSON API routes
    ('lib/mobile-auth.ts',                        'lib/mobile-auth.ts'),
    ('app/api/settings/mobile-token/route.ts',    'app/api/settings/mobile-token/route.ts'),
    # Android companion app — FCM push (parallel to ntfy during migration)
    ('lib/fcm-config.ts',                         'lib/fcm-config.ts'),
    ('lib/push.ts',                               'lib/push.ts'),
    ('app/api/settings/fcm-token/route.ts',       'app/api/settings/fcm-token/route.ts'),
    ('app/api/settings/push-test/route.ts',       'app/api/settings/push-test/route.ts'),
    ('lib/ai-dj-config.ts',                       'lib/ai-dj-config.ts'),
    ('lib/ai-dj-mix.ts',                          'lib/ai-dj-mix.ts'),
    ('lib/ai-dj-prebuild.ts',                      'lib/ai-dj-prebuild.ts'),
    ('lib/csv-heal.ts',                           'lib/csv-heal.ts'),
    ('lib/spotify-rate-limit.ts',                 'lib/spotify-rate-limit.ts'),
    ('lib/spotify-search.ts',                     'lib/spotify-search.ts'),
    ('app/api/tracks/import-lookup-csv/dedup/route.ts',   'app/api/tracks/import-lookup-csv/dedup/route.ts'),
    ('app/api/tracks/import-lookup-csv/confirm/route.ts', 'app/api/tracks/import-lookup-csv/confirm/route.ts'),
    ('lib/track-enrich.ts',                       'lib/track-enrich.ts'),
    ('lib/spotify-playlist.ts',                   'lib/spotify-playlist.ts'),
    ('lib/playlist-id-cache.ts',                   'lib/playlist-id-cache.ts'),
    ('lib/runna-schedule.ts',                     'lib/runna-schedule.ts'),
    ('scripts/bpm_bridge.py',                     'scripts/bpm_bridge.py'),
    ('bpm_matcher/__init__.py',                   'bpm_matcher/__init__.py'),
    ('bpm_matcher/camelot.py',                    'bpm_matcher/camelot.py'),
    ('bpm_matcher/features.py',                   'bpm_matcher/features.py'),
    ('bpm_matcher/db_source.py',                  'bpm_matcher/db_source.py'),
    ('bpm_matcher/match.py',                      'bpm_matcher/match.py'),
    ('bpm_matcher/sources.py',                    'bpm_matcher/sources.py'),
    ('bpm_matcher/enrich.py',                     'bpm_matcher/enrich.py'),
    ('bpm_matcher/suggest.py',                    'bpm_matcher/suggest.py'),
    # AI DJ workout mixer (on-Pi fallback when the remote service is down;
    # source of truth lives in ../AI_DJ)
    ('scripts/ai_dj_bridge.py',                   'scripts/ai_dj_bridge.py'),
    ('scripts/coach_bridge.py',                   'scripts/coach_bridge.py'),
    ('scripts/coach_embed.py',                    'scripts/coach_embed.py'),
    ('scripts/parse_workout_segments.py',         'scripts/parse_workout_segments.py'),
    ('scripts/garmin_notify.sh',                  'scripts/garmin_notify.sh'),
    ('../AI_DJ/ai_dj/__init__.py',                'ai_dj/__init__.py'),
    ('../AI_DJ/ai_dj/workout.py',                 'ai_dj/workout.py'),
    ('../AI_DJ/ai_dj/selector.py',                'ai_dj/selector.py'),
    ('../AI_DJ/ai_dj/llm.py',                     'ai_dj/llm.py'),
    ('../AI_DJ/ai_dj/claude_config.py',           'ai_dj/claude_config.py'),
    ('../AI_DJ/ai_dj/gemini_config.py',           'ai_dj/gemini_config.py'),
    ('.env.local',                                '.env.local'),
]

# Files only uploaded on first deploy — never overwrite user-managed files.
# local-auth.json holds the enrolled 2FA secret on the Pi; overwriting it
# would silently disable 2FA and reset credentials.
SKIP_IF_REMOTE_EXISTS = {'public/Running.csv', 'local-auth.json'}

# ── Upload-skip manifest ──────────────────────────────────────────────────────
# Hashes of every file as of the last SUCCESSFUL deploy: only files whose
# hash changed are uploaded (hashing all ~130 files takes ~40 ms; uploading
# them over SFTP takes ~30 s). Written only after the build passes and the
# service restarts, so a failed deploy never marks its uploads as done.
# Run "python deploy.py --all" (or delete the file) to force a full upload.
MANIFEST_PATH = os.path.join(RUNNING_DIR, '.deploy-manifest.json')
FORCE_ALL = '--all' in sys.argv


def file_sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(65536), b''):
            h.update(chunk)
    return h.hexdigest()


def load_manifest() -> dict:
    if FORCE_ALL:
        return {}
    try:
        with open(MANIFEST_PATH, encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def run(ssh, cmd):
    _, stdout, stderr = ssh.exec_command(cmd)
    out = stdout.read().decode('utf-8', errors='replace').strip()
    err = stderr.read().decode('utf-8', errors='replace').strip()
    if out: print(out.encode('ascii', errors='replace').decode('ascii'))
    if err: print(err.encode('ascii', errors='replace').decode('ascii'))


def sudo_run(ssh, cmd):
    run(ssh, f"echo '{PI['password']}' | sudo -S sh -c '{cmd}'")


# ── Deploy to Raspberry Pi ────────────────────────────────────────────────────
print(f'\n=== Raspberry Pi ({PI["host"]}) ===')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(PI['host'], port=PI['port'],
            username=PI['user'], password=PI['password'], timeout=15)

# Ensure Node.js is available
print('  Checking Node.js...')
sudo_run(ssh, 'which node || (curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs)')
run(ssh, 'node --version && npm --version')

# better-sqlite3 (pacesync.db) ships no prebuilt binary for the Pi's ARM
# architecture, so npm install compiles its native binding from source —
# needs make/g++/python3, which a minimal/Lite Raspberry Pi OS image doesn't
# include by default (this Pi already had them, likely pulled in as a
# dependency of an earlier apt step, but that's not guaranteed on a fresh
# install). Idempotent, same pattern as the python3-pandas check below.
print('  Checking build tools (needed to compile better-sqlite3 for this Pi)...')
sudo_run(ssh, 'which make g++ python3 >/dev/null 2>&1 || apt-get install -y -qq build-essential python3-dev')

# Create remote directory structure
print('  Creating directories...')
unique_dirs = sorted({
    f'{PI_REMOTE}/{os.path.dirname(r).replace(os.sep, "/")}'
    for _, r in FILES
    if os.path.dirname(r)
})
run(ssh, f'mkdir -p {PI_REMOTE}')
for d in unique_dirs:
    run(ssh, f'mkdir -p "{d}"')

# Upload files (only those whose hash changed since the last successful deploy)
sftp = ssh.open_sftp()
manifest = load_manifest()
new_manifest = {}
uploaded = 0
skipped_unchanged = 0
package_json_changed = False
for local_rel, remote_rel in FILES:
    local_path  = os.path.join(RUNNING_DIR, local_rel.replace('/', os.sep))
    remote_path = f'{PI_REMOTE}/{remote_rel}'
    if not os.path.exists(local_path):
        print(f'  SKIP (not found): {local_rel}')
        continue
    if local_rel in SKIP_IF_REMOTE_EXISTS:
        try:
            sftp.stat(remote_path)
            print(f'  SKIP (exists on Pi): {local_rel}')
            continue
        except FileNotFoundError:
            pass  # not on Pi yet — upload seed
    digest = file_sha256(local_path)
    if manifest.get(remote_rel) == digest:
        new_manifest[remote_rel] = digest
        skipped_unchanged += 1
        continue
    if local_rel == 'package.json':
        package_json_changed = True
    print(f'  Uploading {local_rel}...')
    sftp.put(local_path, remote_path)
    new_manifest[remote_rel] = digest
    uploaded += 1
sftp.close()
print(f'  Uploaded {uploaded} changed file(s); {skipped_unchanged} unchanged.')

if uploaded == 0 and manifest:
    print('\nNothing changed since the last deploy — skipping build and restart.')
    ssh.close()
    sys.exit(0)

# Install dependencies + build (npm install only when package.json changed)
if package_json_changed or not manifest:
    print('  Installing npm dependencies...')
    run(ssh, f'cd {PI_REMOTE} && npm install 2>&1 | tail -5')
else:
    print('  package.json unchanged — skipping npm install.')

# Python deps for the AI_BPM matcher (apt = prebuilt Pi packages, idempotent)
print('  Checking Python matcher dependencies...')
run(ssh, 'python3 -c "import pandas, numpy, requests" 2>/dev/null && echo "python deps OK" || echo "installing..."')
sudo_run(ssh, 'python3 -c "import pandas, numpy, requests" 2>/dev/null || apt-get install -y -qq python3-pandas python3-numpy python3-requests')

# anthropic isn't packaged for apt — pip install it directly. Debian 13's
# PEP 668 externally-managed environment needs --break-system-packages;
# this is the system Python the on-Pi Claude bridge (ai_dj_bridge.py) runs
# under, so a venv would need its own activation wiring in ai-dj-mix.ts.
print('  Checking anthropic (Claude API) dependency...')
run(ssh, 'python3 -c "import anthropic" 2>/dev/null && echo "anthropic OK" || echo "installing anthropic..."')
run(ssh, 'python3 -c "import anthropic" 2>/dev/null || pip3 install --break-system-packages -q anthropic')

# Same deal for google-genai (Gemini API).
print('  Checking google-genai (Gemini API) dependency...')
run(ssh, 'python3 -c "import google.genai" 2>/dev/null && echo "google-genai OK" || echo "installing google-genai..."')
run(ssh, 'python3 -c "import google.genai" 2>/dev/null || pip3 install --break-system-packages -q google-genai')

# fastembed (ONNX MiniLM) — the Pi's backup embedding model for Coach memory
# when the PC (bge-large via Ollama) is off. See scripts/coach_embed.py.
print('  Checking fastembed (Coach memory) dependency...')
run(ssh, 'python3 -c "import fastembed" 2>/dev/null && echo "fastembed OK" || echo "installing fastembed..."')
run(ssh, 'python3 -c "import fastembed" 2>/dev/null || pip3 install --break-system-packages -q fastembed')
# fitdecode — reads lap records from activity FIT files for the Coach
# (scripts/fit_laps.py); GarminDB imports laps with empty times/distances.
run(ssh, 'python3 -c "import fitdecode" 2>/dev/null || pip3 install --break-system-packages -q fitdecode')

print('  Building Next.js app...')
# Abort the deploy if the build fails — restarting the service without a
# production build takes the whole app down.
_, _stdout, _ = ssh.exec_command(
    f'cd {PI_REMOTE} && npm run build > /tmp/pacesync-build.log 2>&1; rc=$?; '
    f'tail -30 /tmp/pacesync-build.log; exit $rc'
)
_build_out = _stdout.read().decode('utf-8', errors='replace')
print(_build_out.encode('ascii', errors='replace').decode('ascii'))
if _stdout.channel.recv_exit_status() != 0 or 'Build failed' in _build_out:
    print('\nERROR: next build FAILED on the Pi — service NOT restarted, fix the error above.')
    ssh.close()
    sys.exit(1)

# Write systemd service
print('  Writing systemd service...')
service = f"""[Unit]
Description=PaceSync Running Playlist
After=network.target

[Service]
Type=simple
User={PI['user']}
WorkingDirectory={PI_REMOTE}
Environment=PORT={PORT}
Environment=NODE_ENV=production
{f'Environment=LASTFM_API_KEY={lastfm_key}' if lastfm_key else ''}
ExecStart=/usr/bin/env npm start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
"""
sftp = ssh.open_sftp()
with sftp.open('/tmp/running-playlist.service', 'w') as f:
    f.write(service)
sftp.close()
sudo_run(ssh, 'cp /tmp/running-playlist.service /etc/systemd/system/running-playlist.service')
sudo_run(ssh, 'systemctl daemon-reload && systemctl enable running-playlist && systemctl restart running-playlist')
time.sleep(6)

print('  Status:')
run(ssh, 'systemctl is-active running-playlist')

# Install cron jobs only when absent — the app's Settings page manages their
# schedule (and disables them via a #PACESYNC-OFF# comment marker), so an
# existing entry, active or disabled, is left untouched.
print('  Ensuring cron job (BBC weekly refresh, default Friday 14:00)...')
cron_log = f'/home/{PI["user"]}/cron-weekly.log'
cron_line = (
    f'0 14 * * 5 curl -s -o {cron_log} '
    f'-X POST http://localhost:{PORT}/api/cron/weekly '
    f'-H "X-Cron-Secret: {cron_secret}"'
)
run(ssh, f"""crontab -l 2>/dev/null | grep -q '/api/cron/weekly' || {{ (crontab -l 2>/dev/null; echo '{cron_line}') | crontab -; }}""")

print('  Ensuring cron job (AI DJ pre-build, default daily 15:30)...')
ai_dj_cron_log = f'/home/{PI["user"]}/cron-ai-dj.log'
ai_dj_cron_line = (
    f'30 15 * * * curl -s -o {ai_dj_cron_log} '
    f'-X POST http://localhost:{PORT}/api/cron/ai-dj '
    f'-H "X-Cron-Secret: {cron_secret}"'
)
# Match on the URL plus a trailing space so this never also matches the
# ai-dj-retry job's own install-check below (both share the "/api/cron/ai-dj"
# prefix) — a bare substring grep would make each check think the other job
# already covers it and skip installing itself.
run(ssh, f"""crontab -l 2>/dev/null | grep -q '/api/cron/ai-dj ' || {{ (crontab -l 2>/dev/null; echo '{ai_dj_cron_line}') | crontab -; }}""")

print('  Ensuring cron job (AI DJ morning retry, default daily 06:00)...')
ai_dj_retry_cron_log = f'/home/{PI["user"]}/cron-ai-dj-retry.log'
ai_dj_retry_cron_line = (
    f'0 6 * * * curl -s -o {ai_dj_retry_cron_log} '
    f'-X POST http://localhost:{PORT}/api/cron/ai-dj-retry '
    f'-H "X-Cron-Secret: {cron_secret}"'
)
run(ssh, f"""crontab -l 2>/dev/null | grep -q '/api/cron/ai-dj-retry' || {{ (crontab -l 2>/dev/null; echo '{ai_dj_retry_cron_line}') | crontab -; }}""")

print('  Ensuring cron job (daily digest push, default 06:30)...')
digest_cron_log = f'/home/{PI["user"]}/cron-digest.log'
digest_cron_line = (
    f'30 6 * * * curl -s -o {digest_cron_log} '
    f'-X POST http://localhost:{PORT}/api/cron/digest '
    f'-H "X-Cron-Secret: {cron_secret}"'
)
run(ssh, f"""crontab -l 2>/dev/null | grep -q '/api/cron/digest' || {{ (crontab -l 2>/dev/null; echo '{digest_cron_line}') | crontab -; }}""")

# Daily library <-> Spotify playlist sync — default an hour before the AI DJ
# pre-build (17:30), so the pre-build sees an up-to-date library.
print('  Ensuring cron job (library <-> Spotify sync, default daily 16:30)...')
library_sync_cron_log = f'/home/{PI["user"]}/cron-library-sync.log'
library_sync_cron_line = (
    f'30 16 * * * curl -s -o {library_sync_cron_log} '
    f'-X POST http://localhost:{PORT}/api/cron/library-sync '
    f'-H "X-Cron-Secret: {cron_secret}"'
)
run(ssh, f"""crontab -l 2>/dev/null | grep -q '/api/cron/library-sync' || {{ (crontab -l 2>/dev/null; echo '{library_sync_cron_line}') | crontab -; }}""")

# Overnight library heal — every gap-filling pass, with a result notification.
print('  Ensuring cron job (nightly library heal, default daily 02:00)...')
heal_cron_log = f'/home/{PI["user"]}/cron-heal.log'
heal_cron_line = (
    f'0 2 * * * curl -s -o {heal_cron_log} '
    f'-X POST http://localhost:{PORT}/api/cron/heal '
    f'-H "X-Cron-Secret: {cron_secret}"'
)
run(ssh, f"""crontab -l 2>/dev/null | grep -q '/api/cron/heal' || {{ (crontab -l 2>/dev/null; echo '{heal_cron_line}') | crontab -; }}""")

# 04:00 daily: delete any "_WIP" playlists left behind by unclosed dashboard mixes.
print('  Ensuring cron job (WIP playlist cleanup, daily 04:00)...')
wip_cron_log = f'/home/{PI["user"]}/cron-wip-cleanup.log'
wip_cron_line = (
    f'0 4 * * * curl -s -o {wip_cron_log} '
    f'-X POST http://localhost:{PORT}/api/cron/wip-cleanup '
    f'-H "X-Cron-Secret: {cron_secret}"'
)
run(ssh, f"""crontab -l 2>/dev/null | grep -q '/api/cron/wip-cleanup' || {{ (crontab -l 2>/dev/null; echo '{wip_cron_line}') | crontab -; }}""")

# Daily broken-tracklist check — notifies when an upcoming schedule / Pace Pro
# tracklist still contains a deleted track.
print('  Ensuring cron job (broken tracklist check, default daily 08:00)...')
broken_cron_log = f'/home/{PI["user"]}/cron-broken-tracklists.log'
broken_cron_line = (
    f'0 8 * * * curl -s -o {broken_cron_log} '
    f'-X POST http://localhost:{PORT}/api/cron/broken-tracklists '
    f'-H "X-Cron-Secret: {cron_secret}"'
)
run(ssh, f"""crontab -l 2>/dev/null | grep -q '/api/cron/broken-tracklists' || {{ (crontab -l 2>/dev/null; echo '{broken_cron_line}') | crontab -; }}""")

print('  Ensuring cron job (weekly coach report, default Sunday 19:00)...')
coach_cron_log = f'/home/{PI["user"]}/cron-coach-weekly.log'
coach_cron_line = (
    f'0 19 * * 0 curl -s -m 900 -o {coach_cron_log} '
    f'-X POST http://localhost:{PORT}/api/cron/coach-weekly '
    f'-H "X-Cron-Secret: {cron_secret}"'
)
run(ssh, f"""crontab -l 2>/dev/null | grep -q '/api/cron/coach-weekly' || {{ (crontab -l 2>/dev/null; echo '{coach_cron_line}') | crontab -; }}""")

print('  Ensuring cron job (nutrition AI summary, hourly; writes once a day after 05:00 when the AI DJ service is up)...')
nutrition_cron_log = f'/home/{PI["user"]}/cron-nutrition-summary.log'
nutrition_cron_line = (
    f'7 * * * * curl -s -m 60 -o {nutrition_cron_log} '
    f'-X POST http://localhost:{PORT}/api/cron/nutrition-summary '
    f'-H "X-Cron-Secret: {cron_secret}"'
)
run(ssh, f"""crontab -l 2>/dev/null | grep -q '/api/cron/nutrition-summary' || {{ (crontab -l 2>/dev/null; echo '{nutrition_cron_line}') | crontab -; }}""")

print('  Ensuring cron job (Lose It! food diary, hourly 07:23-23:23; ~4.6 KB per run)...')
loseit_cron_log = f'/home/{PI["user"]}/cron-loseit.log'
loseit_cron_line = (
    f'23 7-23 * * * curl -s -m 120 -o {loseit_cron_log} '
    f'-X POST http://localhost:{PORT}/api/cron/loseit '
    f'-H "X-Cron-Secret: {cron_secret}"'
)
run(ssh, f"""crontab -l 2>/dev/null | grep -q '/api/cron/loseit' || {{ (crontab -l 2>/dev/null; echo '{loseit_cron_line}') | crontab -; }}""")

print('  Ensuring cron job (schedule summary, every 15 min; refreshes it when the Runna plan has changed and the AI DJ service is up)...')
brief_cron_log = f'/home/{PI["user"]}/cron-coach-brief.log'
brief_cron_line = (
    f'*/15 * * * * curl -s -m 60 -o {brief_cron_log} '
    f'-X POST http://localhost:{PORT}/api/cron/coach-brief '
    f'-H "X-Cron-Secret: {cron_secret}"'
)
# Replaces any older entry, so a changed schedule here takes effect on deploy.
run(ssh, f"""crontab -l 2>/dev/null | grep -v '/api/cron/coach-brief' | {{ cat; echo '{brief_cron_line}'; }} | crontab -""")

print('  Ensuring cron job (Garmin weigh-ins, hourly)...')
weight_cron_log = f'/home/{PI["user"]}/cron-garmin-weight.log'
weight_cron_line = (
    f'37 * * * * curl -s -m 60 -o {weight_cron_log} '
    f'-X POST http://localhost:{PORT}/api/cron/garmin-weight '
    f'-H "X-Cron-Secret: {cron_secret}"'
)
run(ssh, f"""crontab -l 2>/dev/null | grep -q '/api/cron/garmin-weight' || {{ (crontab -l 2>/dev/null; echo '{weight_cron_line}') | crontab -; }}""")

# Garmin sync completion notification: sftp doesn't carry the exec bit (and a
# Windows checkout may add CRLFs), so normalise the script, then append it to
# the existing garmin cron line if the hook isn't there yet. The garmin cron
# itself is user-installed (garmin_run.py pre-dates this app), so there's no
# install-if-missing step for it here.
print('  Ensuring nightly PaceSync backup (03:15, to the FILESERVER Backups share)...')
backup_py = f'{PI_REMOTE}/scripts/pacesync_backup.py'
backup_sh = f'{PI_REMOTE}/scripts/pacesync_restore.sh'
run(ssh, f"sed -i 's/\\r$//' {backup_py} {backup_sh} && chmod +x {backup_py} {backup_sh}")
# The share's login lives only on the Pi, in ~/.pacesync-backup.cred (username=/password= lines).
run(ssh, f"test -f /home/{PI['user']}/.pacesync-backup.cred || echo 'WARNING: ~/.pacesync-backup.cred is missing on the Pi: the nightly backup will fail until it is created'")
backup_cron_line = (
    f'15 3 * * * /usr/bin/python3 {backup_py} >> /home/{PI["user"]}/cron-backup.log 2>&1'
)
run(ssh, f"""crontab -l 2>/dev/null | grep -q 'pacesync_backup.py' || {{ (crontab -l 2>/dev/null; echo '{backup_cron_line}') | crontab -; }}""")

print('  Ensuring Garmin sync ntfy hook...')
notify_sh = f'{PI_REMOTE}/scripts/garmin_notify.sh'
after_sh = f'{PI_REMOTE}/scripts/garmin_after_sync.sh'
run(ssh, f"sed -i 's/\\r$//' {after_sh} && chmod +x {after_sh}")
run(ssh, f"sed -i 's/\\r$//' {notify_sh} && chmod +x {notify_sh}")
run(ssh, f"""crontab -l 2>/dev/null | grep 'garmin_run.py' | grep -q 'garmin_notify' || {{ crontab -l 2>/dev/null | sed '/garmin_run.py/ {{ /garmin_notify/! s|$|; {notify_sh} $?| }}' | crontab -; }}""")

ssh.close()

# Record what's now on the Pi — next deploy only uploads files changed since.
with open(MANIFEST_PATH, 'w', encoding='utf-8') as f:
    json.dump(new_manifest, f)

print(f'\nDeploy complete.')
print(f'  App:  http://{PI["host"]}:{PORT}')
print(f'  Logs: journalctl -u running-playlist -f')
if nextauth_url:
    print(f'\nRemember to add to Spotify dashboard:')
    print(f'  Redirect URI: {nextauth_url}/api/auth/callback/spotify')
