# Copy this file to deploy_config.py and fill in your values.
# deploy_config.py is gitignored — never commit it.

PI = {
    'host': '192.168.0.x',   # your Pi's local IP
    'port': 22,
    'user': 'pi',             # SSH username
    'password': 'your_pi_password',
}

PORT      = 5005                          # port the app listens on
PI_REMOTE = '/home/pi/running-playlist'   # deploy directory on the Pi
