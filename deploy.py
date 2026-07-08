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

FILES = [
    ('package.json',                              'package.json'),
    ('next.config.mjs',                           'next.config.mjs'),
    ('tsconfig.json',                             'tsconfig.json'),
    ('tailwind.config.ts',                        'tailwind.config.ts'),
    ('postcss.config.mjs',                        'postcss.config.mjs'),
    ('app/globals.css',                           'app/globals.css'),
    ('app/layout.tsx',                            'app/layout.tsx'),
    ('app/page.tsx',                              'app/page.tsx'),
    ('app/dashboard/page.tsx',                    'app/dashboard/page.tsx'),
    ('app/api/auth/[...nextauth]/route.ts',       'app/api/auth/[...nextauth]/route.ts'),
    ('app/api/spotify/playlists/route.ts',        'app/api/spotify/playlists/route.ts'),
    ('app/api/spotify/tracks/route.ts',           'app/api/spotify/tracks/route.ts'),
    ('app/api/spotify/create-playlist/route.ts',  'app/api/spotify/create-playlist/route.ts'),
    ('app/api/spotify/add-tracks/route.ts',       'app/api/spotify/add-tracks/route.ts'),
    ('app/api/save-default-playlist/route.ts',    'app/api/save-default-playlist/route.ts'),
    ('app/api/tracks/delete/route.ts',            'app/api/tracks/delete/route.ts'),
    ('app/api/tracks/add/route.ts',               'app/api/tracks/add/route.ts'),
    ('app/api/tracks/update-features/route.ts',   'app/api/tracks/update-features/route.ts'),
    ('app/api/bbc/tracks/route.ts',               'app/api/bbc/tracks/route.ts'),
    ('app/api/bbc/episode-info/route.ts',         'app/api/bbc/episode-info/route.ts'),
    ('app/api/bbc/schedule/route.ts',             'app/api/bbc/schedule/route.ts'),
    ('app/api/bbc/programmes/route.ts',           'app/api/bbc/programmes/route.ts'),
    ('app/api/itunes-art/route.ts',               'app/api/itunes-art/route.ts'),
    ('app/api/spotify/playlist-uris/route.ts',    'app/api/spotify/playlist-uris/route.ts'),
    ('app/api/cron/weekly/route.ts',              'app/api/cron/weekly/route.ts'),
    ('app/api/cron/test/route.ts',                'app/api/cron/test/route.ts'),
    ('app/api/settings/hr-zones/route.ts',        'app/api/settings/hr-zones/route.ts'),
    ('app/api/settings/runna-url/route.ts',       'app/api/settings/runna-url/route.ts'),
    ('app/api/settings/ntfy/route.ts',            'app/api/settings/ntfy/route.ts'),
    ('app/api/settings/garmin/route.ts',          'app/api/settings/garmin/route.ts'),
    ('app/api/settings/garmin/sync-status/route.ts', 'app/api/settings/garmin/sync-status/route.ts'),
    ('app/api/garmin/data/route.ts',              'app/api/garmin/data/route.ts'),
    ('app/api/garmin/pace-spm/route.ts',          'app/api/garmin/pace-spm/route.ts'),
    ('app/api/garmin/similar-activities/route.ts', 'app/api/garmin/similar-activities/route.ts'),
    ('app/api/garmin/route/[id]/route.ts',        'app/api/garmin/route/[id]/route.ts'),
    ('components/RouteMapLightbox.tsx',           'components/RouteMapLightbox.tsx'),
    ('app/garmin/page.tsx',                       'app/garmin/page.tsx'),
    ('app/garmin/activity/[id]/page.tsx',         'app/garmin/activity/[id]/page.tsx'),
    ('app/api/garmin/activity/[id]/route.ts',     'app/api/garmin/activity/[id]/route.ts'),
    ('components/GarminClient.tsx',               'components/GarminClient.tsx'),
    ('components/GarminActivityClient.tsx',       'components/GarminActivityClient.tsx'),
    ('lib/garmin-config.ts',                      'lib/garmin-config.ts'),
    ('app/api/runna/workouts/route.ts',           'app/api/runna/workouts/route.ts'),
    ('components/RunnaCard.tsx',                  'components/RunnaCard.tsx'),
    ('app/settings/page.tsx',                     'app/settings/page.tsx'),
    ('app/settings/SettingsClient.tsx',           'app/settings/SettingsClient.tsx'),
    ('lib/tokenStore.ts',                         'lib/tokenStore.ts'),
    ('lib/runna-config.ts',                       'lib/runna-config.ts'),
    ('lib/ntfy-config.ts',                        'lib/ntfy-config.ts'),
    ('lib/ntfy.ts',                               'lib/ntfy.ts'),
    ('lib/strava-config.ts',                      'lib/strava-config.ts'),
    ('lib/strava-tokens.ts',                      'lib/strava-tokens.ts'),
    ('lib/strava.ts',                             'lib/strava.ts'),
    ('app/api/strava/connect/route.ts',           'app/api/strava/connect/route.ts'),
    ('app/api/strava/callback/route.ts',          'app/api/strava/callback/route.ts'),
    ('app/api/strava/stats/route.ts',             'app/api/strava/stats/route.ts'),
    ('app/api/settings/strava/route.ts',          'app/api/settings/strava/route.ts'),
    ('app/api/garmin/auto-sync/route.ts',         'app/api/garmin/auto-sync/route.ts'),
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
    ('components/BbcBrowserCard.tsx',             'components/BbcBrowserCard.tsx'),
    ('components/BbcRadioClient.tsx',             'components/BbcRadioClient.tsx'),
    ('app/bbc/page.tsx',                          'app/bbc/page.tsx'),
    ('components/DedupCard.tsx',                  'components/DedupCard.tsx'),
    ('components/DashboardClient.tsx',            'components/DashboardClient.tsx'),
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
    ('app/api/ai-dj/mix/route.ts',                'app/api/ai-dj/mix/route.ts'),
    ('app/api/ai-dj/health/route.ts',             'app/api/ai-dj/health/route.ts'),
    ('app/api/ai-dj/wake/route.ts',               'app/api/ai-dj/wake/route.ts'),
    ('app/api/ai-dj/pin/route.ts',                'app/api/ai-dj/pin/route.ts'),
    ('lib/pinned-mixes.ts',                       'lib/pinned-mixes.ts'),
    ('app/api/settings/bpm-overrides/route.ts',   'app/api/settings/bpm-overrides/route.ts'),
    ('lib/bpm-overrides.ts',                      'lib/bpm-overrides.ts'),
    ('app/api/settings/ai-dj/route.ts',           'app/api/settings/ai-dj/route.ts'),
    ('app/api/cron/ai-dj/route.ts',               'app/api/cron/ai-dj/route.ts'),
    ('lib/cron-schedule.ts',                      'lib/cron-schedule.ts'),
    ('lib/cron-log.ts',                           'lib/cron-log.ts'),
    ('lib/todays-run-history.ts',                 'lib/todays-run-history.ts'),
    ('lib/run-pace-bias.ts',                      'lib/run-pace-bias.ts'),
    ('lib/track-feedback.ts',                     'lib/track-feedback.ts'),
    ('lib/running-playlist-config.ts',            'lib/running-playlist-config.ts'),
    ('app/api/settings/playlist/route.ts',        'app/api/settings/playlist/route.ts'),
    ('app/api/settings/playlists/route.ts',       'app/api/settings/playlists/route.ts'),
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
    ('lib/ai-dj-config.ts',                       'lib/ai-dj-config.ts'),
    ('lib/ai-dj-mix.ts',                          'lib/ai-dj-mix.ts'),
    ('lib/spotify-playlist.ts',                   'lib/spotify-playlist.ts'),
    ('lib/runna-schedule.ts',                     'lib/runna-schedule.ts'),
    ('scripts/bpm_bridge.py',                     'scripts/bpm_bridge.py'),
    ('bpm_matcher/__init__.py',                   'bpm_matcher/__init__.py'),
    ('bpm_matcher/camelot.py',                    'bpm_matcher/camelot.py'),
    ('bpm_matcher/features.py',                   'bpm_matcher/features.py'),
    ('bpm_matcher/match.py',                      'bpm_matcher/match.py'),
    ('bpm_matcher/sources.py',                    'bpm_matcher/sources.py'),
    ('bpm_matcher/enrich.py',                     'bpm_matcher/enrich.py'),
    ('bpm_matcher/suggest.py',                    'bpm_matcher/suggest.py'),
    # AI DJ workout mixer (on-Pi fallback when the remote service is down;
    # source of truth lives in ../AI_DJ)
    ('scripts/ai_dj_bridge.py',                   'scripts/ai_dj_bridge.py'),
    ('scripts/garmin_notify.sh',                  'scripts/garmin_notify.sh'),
    ('../AI_DJ/ai_dj/__init__.py',                'ai_dj/__init__.py'),
    ('../AI_DJ/ai_dj/workout.py',                 'ai_dj/workout.py'),
    ('../AI_DJ/ai_dj/selector.py',                'ai_dj/selector.py'),
    ('../AI_DJ/ai_dj/llm.py',                     'ai_dj/llm.py'),
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
run(ssh, f"""crontab -l 2>/dev/null | grep -q '/api/cron/ai-dj' || {{ (crontab -l 2>/dev/null; echo '{ai_dj_cron_line}') | crontab -; }}""")

# Garmin sync completion notification: sftp doesn't carry the exec bit (and a
# Windows checkout may add CRLFs), so normalise the script, then append it to
# the existing garmin cron line if the hook isn't there yet. The garmin cron
# itself is user-installed (garmin_run.py pre-dates this app), so there's no
# install-if-missing step for it here.
print('  Ensuring Garmin sync ntfy hook...')
notify_sh = f'{PI_REMOTE}/scripts/garmin_notify.sh'
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
