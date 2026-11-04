#!/bin/sh
# Installs or updates the LiveKit node for the video and audio rooms on a box
# that already runs other things. Run as root from this folder:
#   sh install.sh <public IPv4 of the API server>
# It touches only what uninstall.sh removes: /opt/live-room-livekit,
# /etc/live-room-livekit, the live-room-livekit unit, one nginx site, its
# certificate, the ACME folder, and four ufw rules commented "live-room".
set -eu
API_IP=${1:?usage: sh install.sh <public IPv4 of the API server>}
echo "$API_IP" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' || { echo "not an IPv4 address: $API_IP" >&2; exit 1; }
HOST=livekit.tahmidalavi.com
VERSION=1.13.11
# From the release's checksums.txt, pinned here so a swapped download fails.
SHA256=1e9ee90ca301e1842b2887fc77cb122759756a9c8aeb4334ee91de3325ec43fb
here=$(cd "$(dirname "$0")" && pwd)
site=/etc/nginx/sites-available/live-room-livekit
link=/etc/nginx/sites-enabled/live-room-livekit
keys=/etc/live-room-livekit/keys.env
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# A restart drops everyone in every room, so it happens only when the
# binary, the config or the unit actually changed.
changed=0
put() {
  if ! cmp -s "$1" "$2"; then
    install -D -m "$3" "$1" "$2"
    changed=1
  fi
}

if ! /opt/live-room-livekit/livekit-server --version 2>/dev/null | grep -q "$VERSION"; then
  curl -fsSL -o "$tmp/lk.tar.gz" \
    "https://github.com/livekit/livekit/releases/download/v$VERSION/livekit_${VERSION}_linux_amd64.tar.gz"
  echo "$SHA256  $tmp/lk.tar.gz" | sha256sum -c --quiet
  tar -xzf "$tmp/lk.tar.gz" -C "$tmp" livekit-server
  put "$tmp/livekit-server" /opt/live-room-livekit/livekit-server 755
fi

put "$here/livekit.yaml" /etc/live-room-livekit/livekit.yaml 644
if ! grep -Eq '^LIVEKIT_KEYS=[^ ]+: [^ ]+' "$keys" 2>/dev/null; then
  [ -f "$keys" ] || printf 'LIVEKIT_KEYS=\n' > "$keys"
  chmod 600 "$keys"
  echo "Put the API's key and secret in $keys as LIVEKIT_KEYS=<key>: <secret>, then run this again." >&2
  exit 1
fi
# Also when the file was made by hand with the default umask: it is a secret.
chmod 600 "$keys"

put "$here/live-room-livekit.service" /etc/systemd/system/live-room-livekit.service 644
systemctl daemon-reload
systemctl enable live-room-livekit
if [ "$changed" = 1 ] || ! systemctl is-active --quiet live-room-livekit; then
  systemctl restart live-room-livekit
fi

ufw allow 7891/tcp comment 'live-room livekit tcp'
ufw allow 7892/udp comment 'live-room livekit media'
ufw allow 3479/udp comment 'live-room turn'
ufw allow 44200:44300/udp comment 'live-room turn relay'

# nginx is shared. A new site file is tested before it replaces the old one;
# if nginx rejects it, the previous file goes back (or, on a first install,
# the site stays off), so the other sites never see a broken config.
apply_site() {
  [ -f "$site" ] && cp "$site" "$tmp/site.previous"
  cp "$1" "$site"
  ln -sf "$site" "$link"
  if ! nginx -t 2>/dev/null; then
    if [ -f "$tmp/site.previous" ]; then
      cp "$tmp/site.previous" "$site"
    else
      rm -f "$link" "$site"
    fi
    nginx -t
    echo "nginx rejected the new $site; the previous state is back" >&2
    exit 1
  fi
  systemctl reload nginx
}

install -d -m 755 /var/www/live-room-acme
if [ ! -f "/etc/letsencrypt/live/$HOST/fullchain.pem" ]; then
  apply_site "$here/nginx-http.conf"
  # Uses the box's existing ACME account; with several accounts certbot would
  # ask which one, so pass --account then.
  certbot certonly --webroot -w /var/www/live-room-acme -d "$HOST" \
    --non-interactive --keep-until-expiring --deploy-hook 'systemctl reload nginx'
fi
cat "$here/nginx-http.conf" "$here/nginx-https.conf" | sed "s/API_SERVER_IP/$API_IP/" > "$tmp/site.new"
apply_site "$tmp/site.new"

systemctl --no-pager --lines=0 status live-room-livekit
echo "done: https://$HOST, metrics readable from $API_IP only"
