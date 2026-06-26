"""Deploy PaceSync Running Playlist to a Raspberry Pi.

Before deploying:
  1. Copy deploy_config.example.py to deploy_config.py and fill in your Pi details.
  2. Ensure .env.local is filled in with all credentials (see .env.example).
  3. In Spotify dashboard, add redirect URI: {NEXTAUTH_URL}/api/auth/callback/spotify
"""

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
    ('app/api/runna/workouts/route.ts',           'app/api/runna/workouts/route.ts'),
    ('components/RunnaCard.tsx',                  'components/RunnaCard.tsx'),
    ('app/settings/page.tsx',                     'app/settings/page.tsx'),
    ('app/settings/SettingsClient.tsx',           'app/settings/SettingsClient.tsx'),
    ('lib/tokenStore.ts',                         'lib/tokenStore.ts'),
    ('lib/runna-config.ts',                       'lib/runna-config.ts'),
    ('public/Running.csv',                        'public/Running.csv'),
    ('public/favicon.svg',                        'public/favicon.svg'),
    ('public/hero.png',                            'public/hero.png'),
    ('public/dashboard-hero.png',                  'public/dashboard-hero.png'),
    ('components/AuthProvider.tsx',               'components/AuthProvider.tsx'),
    ('components/BbcPlaylistCard.tsx',            'components/BbcPlaylistCard.tsx'),
    ('components/BbcBrowserCard.tsx',             'components/BbcBrowserCard.tsx'),
    ('components/DedupCard.tsx',                  'components/DedupCard.tsx'),
    ('components/DashboardClient.tsx',            'components/DashboardClient.tsx'),
    ('components/SignInButton.tsx',               'components/SignInButton.tsx'),
    ('components/TrackRow.tsx',                   'components/TrackRow.tsx'),
    ('components/ZoneCard.tsx',                   'components/ZoneCard.tsx'),
    ('lib/auth.ts',                               'lib/auth.ts'),
    ('lib/itunes-art.ts',                         'lib/itunes-art.ts'),
    ('lib/bpm-zones.ts',                          'lib/bpm-zones.ts'),
    ('lib/spotify.ts',                            'lib/spotify.ts'),
    ('types/index.ts',                            'types/index.ts'),
    ('types/next-auth.d.ts',                      'types/next-auth.d.ts'),
    ('.env.local',                                '.env.local'),
]

# Files only uploaded on first deploy — never overwrite user-managed files
SKIP_IF_REMOTE_EXISTS = {'public/Running.csv'}


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

# Upload files
sftp = ssh.open_sftp()
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
    print(f'  Uploading {local_rel}...')
    sftp.put(local_path, remote_path)
sftp.close()

# Install dependencies + build
print('  Installing npm dependencies...')
run(ssh, f'cd {PI_REMOTE} && npm install 2>&1 | tail -5')

print('  Building Next.js app...')
run(ssh, f'cd {PI_REMOTE} && npm run build 2>&1 | tail -20')

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

# Install cron job — every Friday at 14:00 local time
print('  Installing cron job (Friday 14:00)...')
cron_log = f'/home/{PI["user"]}/cron-weekly.log'
cron_line = (
    f'0 14 * * 5 curl -s -o {cron_log} '
    f'-X POST http://localhost:{PORT}/api/cron/weekly '
    f'-H "X-Cron-Secret: {cron_secret}"'
)
run(ssh, f"""(crontab -l 2>/dev/null | grep -v '/api/cron/weekly'; echo '{cron_line}') | crontab -""")

ssh.close()

print(f'\nDeploy complete.')
print(f'  App:  http://{PI["host"]}:{PORT}')
print(f'  Logs: journalctl -u running-playlist -f')
if nextauth_url:
    print(f'\nRemember to add to Spotify dashboard:')
    print(f'  Redirect URI: {nextauth_url}/api/auth/callback/spotify')
