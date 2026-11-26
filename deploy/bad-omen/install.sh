#!/usr/bin/env bash
# Sets up automatic deploys on this server: a systemd user timer that runs autodeploy.sh every
# 2 minutes. Run it once, as the user that runs Album Viewer (no sudo needed if it already lingers):
#   bash ~/album-viewer/deploy/bad-omen/install.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
units="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$units"
install -m 644 "$here/album-viewer-deploy.service" "$here/album-viewer-deploy.timer" "$units/"

# User timers only run while you're logged in, unless your user "lingers".
if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != yes ]; then
  loginctl enable-linger "$USER" || echo "Run 'sudo loginctl enable-linger $USER' so deploys also run while you're logged out."
fi

systemctl --user daemon-reload
systemctl --user enable --now album-viewer-deploy.timer
systemctl --user list-timers album-viewer-deploy.timer --no-pager
echo "What it did: journalctl --user -u album-viewer-deploy -e"
