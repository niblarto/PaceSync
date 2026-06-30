# PaceSync — Running Playlist Manager

A Next.js web app for managing a Spotify running playlist based on heart rate zones. Runs as a self-hosted service on a Raspberry Pi.

**Features**
- Browse tracks by BPM / heart rate zone (Z1–Z5)
- Add tracks from BBC Radio playlists directly to Spotify
- Play tracks in Spotify
- Delete tracks from Spotify and local CSV simultaneously
- Import and auto-save your Exportify CSV export
- Runna training calendar integration with zone suggestions
- Dedup playlist, to remove duplicate tracks
- Garmin activity stats: pace/cadence tables and per-lap speed segments, read directly from a local [GarminDB](https://github.com/tcgoetz/GarminDB) database
- Weekly cron job to keep the playlist fresh:-
    - Pull down the tracks of the last show, for the BBC programmes that are currently subcribed to
    - Upload to the Spotify "Running" playlist, then dedupe the "Running" playlist.

---

## Prerequisites

- Pi OS / Debian
- Python 3 with `paramiko` installed on your **local machine** (for deployment)
- A [Spotify Developer](https://developer.spotify.com/dashboard) app
- Your running playlist exported from Spotify using [Exportify](https://exportify.net) as a CSV with BPM data

---

## 1. Spotify App Setup

1. Go to [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and create an app.
2. Note the **Client ID** and **Client Secret**.
3. Under **Redirect URIs**, add:
   ```
   https://your-domain.com/api/auth/callback/spotify
   ```
   (or `http://localhost:3000/api/auth/callback/spotify` for local dev)

---

## 2. Configure Environment Variables

```bash
cp .env.example .env.local
```

Edit `.env.local` and fill in all required values:

| Variable | Required | Description |
|---|---|---|
| `SPOTIFY_CLIENT_ID` | ✅ | From Spotify Developer Dashboard |
| `SPOTIFY_CLIENT_SECRET` | ✅ | From Spotify Developer Dashboard |
| `NEXTAUTH_SECRET` | ✅ | Random string: `openssl rand -base64 32` |
| `NEXTAUTH_URL` | ✅ | Your public URL, e.g. `https://your-domain.com` (or `http://localhost:3000` for local dev) |
| `CRON_SECRET` | ✅ | Random string: `openssl rand -hex 24` — protects the cron endpoint |
| `NEXT_PUBLIC_RUNNING_PLAYLIST_ID` | ✅ | Your Spotify running playlist ID |
| `RUNNA_ICS_URL` | optional | Your Runna calendar ICS URL — can also be set in **Settings → Runna Integration** after deploy |
| `NTFY_TOPIC` | optional | Your ntfy.sh topic name for push notifications — can also be set in **Settings → Push Notifications** after deploy |
| `GARMINDB_SYNC_WRAPPER` | optional | Path to the GarminDB sync wrapper script (see [GarminDB Integration](#garmindb-integration)) — only needed for the Settings sync-status card |
| `GARMINDB_PYTHON_BIN` | optional | Path to the Python binary inside your GarminDB venv |
| `GARMINDB_LOG_PATH` | optional | Path to the GarminDB sync log file |

To find your **playlist ID**: open the playlist on [open.spotify.com](https://open.spotify.com), copy the URL — the ID is the string after `/playlist/`.

> **Settings page overrides**: `RUNNA_ICS_URL` and `NTFY_TOPIC` can be left blank here and configured directly in the app after deploying. Values saved via Settings take precedence over `.env.local`.

---

## 3. Configure Deployment Target

```bash
cp deploy_config.example.py deploy_config.py
```

Edit `deploy_config.py` with your Pi's details:

```python
PI = {
    'host': '192.168.0.x',   # Pi's local IP address
    'port': 22,
    'user': 'pi',             # SSH username
    'password': 'your_pi_password',
}

PORT      = 5005
PI_REMOTE = '/home/pi/running-playlist'
```

> `deploy_config.py` is gitignored — it will never be committed.

---

## 4. Deploy to Raspberry Pi

Install the deploy dependency on your local machine if needed:

```bash
pip install paramiko
```

Then run:

```bash
python deploy.py
```

This will:
1. Upload all source files to the Pi over SSH/SFTP
2. Run `npm install` and `npm run build` on the Pi
3. Install and start a `systemd` service (`running-playlist`)
4. Set up a weekly cron job (Fridays at 14:00) to refresh the playlist

The app will be available at `http://<pi-ip>:5005`.

---

## 5. Export Your Spotify Playlist with Exportify

PaceSync needs your Spotify playlist as a CSV file with BPM data. Exportify is a free tool that generates this.

1. Go to [exportify.net](https://exportify.net) and click **Log in with Spotify**.
2. Find your running playlist in the list and click **Export**.
3. Exportify downloads a `.csv` file containing all tracks with BPM, energy, and other audio features.

> **Note:** Exportify is required specifically because Spotify's audio features API (which provides BPM data) is no longer accessible to newer personal developer accounts. Exportify uses a different access path to retrieve this data. This app cannot fetch BPM data directly from Spotify. (Other older apps still can)

---

## 6. Upload the CSV to PaceSync

1. Open the app and sign in with Spotify.
2. Go to **Settings**.
3. Under **Import Playlist**, click **Upload CSV** and select the file downloaded from Exportify.
4. The file is saved on the Pi as `Running.csv`.
5. Return to the **Dashboard** — your tracks will load automatically.

---

## 7. First-Time Setup in the Browser

1. Go to **Settings** → **Heart Rate Settings** and enter your max HR and resting HR to calculate your zones. Override individual zone boundaries if needed, then click **Save zones**.
2. (Optional) Connect Runna — see [Runna Integration](#runna-integration) below.
3. (Optional) Add BBC Radio programme cards from the dashboard to have tracks added to your Running playlist automatically each week.

---

## Zone Selection

Click any zone in the left column to filter tracks and build a playlist for that zone.

**Multi-zone selection:** Hold **Ctrl** (or **Cmd** on Mac) and click additional zones to combine them. Tracks from all selected zones are merged into a single list and the playlist name updates automatically — e.g. selecting Zone 1 and Zone 2 produces `Running – Z1Z2`, selecting Zone 2 and Zone 4 produces `Running – Z2Z4`.

Ctrl+clicking an already-selected zone removes it. Clicking any zone without Ctrl resets to a single-zone selection.

---

## BBC Radio Cards

PaceSync can pull tracks from BBC Radio programmes and add them directly to your Spotify running playlist.

**Setting up a BBC card:**

1. Go to the **Dashboard** and click **Add BBC Programme** (or the BBC browser card).
2. Click on a Station (e.g. Radio 2, Radio 6 Music)
3. Search for a BBC programme by name (e.g. "6 Music's 90s Forever", "Sarah Cox Breakfast Show").
4. Select the programme from the results — a card will appear on the dashboard showing the most recent episode's tracklist.
5. Click **Add to Spotify** on the card to add all tracks from that episode to your Running playlist immediately.

**Automatic weekly updates:**

Once a programme card is added, the weekly cron job (Fridays at 14:00) will automatically fetch the latest episode's tracks and add them to your playlist. You can also trigger this manually from **Settings** → **Run Now**.

**Important: BPM data is not fetched automatically.**

When tracks are added to Spotify via BBC cards, they appear in the playlist but PaceSync has no way to retrieve their BPM data. Spotify's audio features API (`/audio-features`) is no longer accessible to newer personal developer accounts, so the app cannot look up tempo automatically.

**To get BPM data for newly added tracks:**

1. After tracks have been added to Spotify, go to [exportify.net](https://exportify.net) and re-export your running playlist.
2. Go to **Settings** → **Import Playlist** and upload the new CSV.

Until you do this, newly added BBC tracks will not appear in any zone on the dashboard (they have no BPM data and cannot be sorted into a zone).

---

## Runna Integration

PaceSync can pull your upcoming Runna workouts and display them on the dashboard with suggested heart rate zones.

**Finding your iCal URL:**

1. Open the **Runna app** on your phone
2. Tap **Profile** → **Settings**
3. Tap **Calendar Integration**
4. Copy the **iCal / Webcal URL**

**Adding it to PaceSync:**

Go to **Settings** → **Runna Integration**, paste the URL, and click **Save URL**. The URL is stored on the Pi and takes effect immediately — no restart required.

> Keep the URL private. It provides read-only access to your training schedule.

Alternatively, you can set `RUNNA_ICS_URL` in `.env.local` before deploying — the app will use the settings page value if set, otherwise falls back to the environment variable.

---

## GarminDB Integration

PaceSync's **Garmin** page (activity list, pace/cadence tables, per-lap speed segments) reads directly from a local SQLite database — it does not call the Garmin Connect API itself. That database is produced by [**GarminDB**](https://github.com/tcgoetz/GarminDB), a separate open-source tool by Tom Goetz that syncs your Garmin Connect data to SQLite.

Because PaceSync reads the SQLite file straight off disk (via `better-sqlite3`), **GarminDB must be installed on the same Pi/server that runs PaceSync** — there's no network sync between them, just a shared file.

### Install GarminDB on the Pi

SSH into the Pi and set up GarminDB in its own virtual environment:

```bash
python3 -m venv ~/garmindb-venv
~/garmindb-venv/bin/pip install garmindb
```

Create the config file with your Garmin Connect credentials:

```bash
mkdir -p ~/.GarminDb
cp ~/garmindb-venv/lib/python*/site-packages/garmindb/GarminConnectConfig.json.example \
   ~/.GarminDb/GarminConnectConfig.json
```

Edit `~/.GarminDb/GarminConnectConfig.json`:
- Set `credentials.user` / `credentials.password` to your Garmin Connect login.
- `data.download_all_activities` controls how many historical activities a full sync fetches (default `1000`).

Run the first full sync (this downloads your entire activity history and can take a while):

```bash
~/garmindb-venv/bin/python3 ~/garmindb-venv/bin/garmindb_cli.py --all --download --import --analyze
```

This creates the databases under `~/HealthData/DBs/`. PaceSync only needs **`garmin_activities.db`** from that folder.

### Point PaceSync at the database

1. In PaceSync, go to **Settings → Garmin** (or visit `/garmin` and follow the prompt if it's not configured yet).
2. Enter the full path to the database, e.g. `/home/pi/HealthData/DBs/garmin_activities.db`.
3. Save — the **Garmin** page will start showing your activities immediately.

### Keeping it in sync

Add a daily cron job on the Pi to pull new activities (`--latest` only fetches recent ones, so it stays fast):

```bash
crontab -e
```

```
0 15 * * * /home/pi/garmindb-venv/bin/python3 /home/pi/garmindb-venv/bin/garmindb_cli.py --all --download --import --analyze --latest
```

> **Sync status card:** Settings also shows a live sync status card with a log tail and a "Sync now" button. This launches GarminDB through a small wrapper script that timestamps each log line (so tqdm progress bars can be parsed) and reads back from a fixed log path. If you want that card to work, write a timestamping wrapper around `garmindb_cli.py` on the Pi (it just needs to prefix each output line with a time and write to a log file) and set `GARMINDB_SYNC_WRAPPER`, `GARMINDB_PYTHON_BIN`, and `GARMINDB_LOG_PATH` in `.env.local` to match your paths. Without it, you can still sync GarminDB manually via cron/SSH — only the status card's live log and "Sync now" button won't work.

### Notes

- GarminDB occasionally fails to download a FIT file for an activity that Garmin Connect only stores as GPX (no FIT archived) — those activities won't have per-second speed/cadence data, which is a Garmin Connect limitation, not a PaceSync or GarminDB bug.
- If an activity fails to import with an `UnknownEnumValue` error on `hr_zones_method`, that's a known GarminDB parsing edge case for certain FIT files — the rest of the sync still completes normally.
- The intial data pull from Garmin to the local database can take hours, the transfer is throttled so that excessive data grab thresholds are not breached, leading to 429 errors

---

## Push Notifications (ntfy.sh)

PaceSync can send push notifications to your phone when the weekly playlist update runs, using [ntfy.sh](https://ntfy.sh) — a free, open source notification service.

**Setting up ntfy.sh:**

1. Install the **ntfy app** on your phone:
   - [iOS — App Store](https://apps.apple.com/app/ntfy/id1625396347)
   - [Android — Play Store / F-Droid](https://ntfy.sh/docs/subscribe/phone/)
2. In the ntfy app, tap **+** and subscribe to a topic — choose any name you like, e.g. `my_running_playlist_abc123`. Topic names are public, so use something unique and hard to guess.
3. In PaceSync, go to **Settings** → **Push Notifications** and enter the same topic name, then click **Save topic**.

Alternatively, set `NTFY_TOPIC` in `.env.local` before deploying — the Settings page value takes precedence if set.

**What you'll receive:**

- A notification when the weekly update starts, listing the BBC programmes being processed
- A per-programme notification with how many tracks were found and added
- A final summary with total tracks added and deduplication results
- Error notifications (with high priority) if anything goes wrong

---

## Updating

After making code changes, redeploy with:

```bash
python deploy.py
```

Your `Running.csv` on the Pi will not be overwritten.

---

## Raspberry Pi Service Management

```bash
# Check status
systemctl status running-playlist

# View live logs
journalctl -u running-playlist -f

# Restart
sudo systemctl restart running-playlist
```

---

## Local Development

```bash
npm install
npm run dev
```

App runs at `http://localhost:3000`. You will need to add `http://localhost:3000/api/auth/callback/spotify` as a redirect URI in your Spotify app.
