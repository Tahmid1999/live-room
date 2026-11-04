#!/bin/sh
# Removes everything install.sh added and nothing else. Run as root.
set -u
systemctl disable --now live-room-livekit 2>/dev/null
rm -f /etc/systemd/system/live-room-livekit.service
systemctl daemon-reload
rm -f /etc/nginx/sites-enabled/live-room-livekit /etc/nginx/sites-available/live-room-livekit
nginx -t && systemctl reload nginx
certbot delete --cert-name livekit.tahmidalavi.com --non-interactive 2>/dev/null
ufw delete allow 7891/tcp
ufw delete allow 7892/udp
ufw delete allow 3479/udp
ufw delete allow 44200:44300/udp
rm -rf /opt/live-room-livekit /etc/live-room-livekit /var/www/live-room-acme
echo "live-room LiveKit node removed"
