I built Live Room to show a live-streaming backend end to end: video and audio rooms, chat, gifts paid from a coin wallet, and an admin view of bandwidth.
It is still being built, so this page will grow as the pieces land.

## The hardest decision

I wanted to stream video on a self-hosted LiveKit, and the hard part was bandwidth. A self-hosted SFU sends every viewer their own copy of the stream, so the server's outgoing traffic grows with every viewer, and for video that grows faster than a server I pay for can carry. Here both room kinds, video and audio, run on the same LiveKit node, so the problem shows on my own server instead of being handed to someone else's.

What I did about it:

- Measured, not assumed. Each viewer's player reports its total receive bitrate every 5 s (summed over its tracks), and the API groups the reports by the kind of room. The per-viewer rate for a kind is the median of that kind's reports. The node's own outgoing rate comes from LiveKit's `livekit_packet_bytes` counter, read through nginx at `LIVEKIT_METRICS_URL`; it is the line `/admin/bandwidth` draws, with the reported sums beside it as a cross-check.
- A monthly budget the API enforces. Every sampler slot adds the node's measured outgoing bytes to a Redis counter for the UTC month (`eg:month:YYYY-MM`). At 80% of `BUDGET_TB_MONTH`, video joins and renewals are refused with `video paused until the 1st: monthly transfer budget 80% used`, the seat sweep removes the video viewers, and the house video host stops. Audio keeps running, since it is a small fraction of the bytes.
- Caps sized from it: 20 viewers in a video room, 50 in an audio room. Both are sized from the measured per-viewer rate and the share of a box I do not own that I want a demo to take. The house video stream tops out at 0.8 Mbps, so a full video room is about 16 Mbps out, plus audio.
- A projection. One line per kind, sloped by that kind's measured per-viewer rate, against the budget line, with the viewer count where each crosses. Video crosses at a small number of viewers; audio crosses far later.

In production I moved video off the self-hosted node because of exactly this crossing; audio stayed on it.

## Running LiveKit without Docker

Both room kinds need a LiveKit server. Copy `livekit.dev.example.yaml` to `livekit.dev.yaml`, put the same key and secret as `api/.env` under `keys`, then run the server binary against it:

    livekit-server --config livekit.dev.yaml

The API reads the bytes LiveKit has sent from `LIVEKIT_METRICS_URL`, which in dev is `http://127.0.0.1:6789/metrics`, and `LIVEKIT_URL` is `ws://127.0.0.1:7890`.

## Running the phone web app

MongoDB (replica set) and Redis must already be up, with `api/.env` filled in. In dev set `WEB_ORIGIN=http://localhost:3130` there, because the socket connects to the API directly. Then, in three terminals:

    livekit-server --config livekit.dev.yaml
    cd api && npm run seed && npm run start:dev
    cd web && npm install && npm run dev

The app is at `http://localhost:3130`. It calls the API through a Next rewrite (`/api/*` to `127.0.0.1:4110`, override with `API_ORIGIN`), and the socket goes to `NEXT_PUBLIC_SOCKET_URL` (set in `web/.env.development`). In production both `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_SOCKET_URL` are the API's own host.

Both rooms work against the local LiveKit server. With `LIVEKIT_METRICS_URL` empty nothing is counted against the budget and video never pauses, which is what you want on a laptop; the admin page says "not measured yet" until the first reading.

### Browser test

    cd web && npx playwright install chromium && npx playwright test viewer

Playwright starts LiveKit, the API and the web app if they are not already running (the first API start compiles, so allow a minute). The test clears the per-IP guest and join counters in Redis db 0 first and runs `npm run seed`, so it is safe to repeat.

## House hosts

The two house rooms are kept alive by a small worker in `house/` that drives headless Chromium with fake media and publishes from the page at `/house`. The audio room is published from boot. The video room is published at 640x360, 15 fps, one layer (about 0.8 Mbps at most), and only while someone is watching: it stops 60 s after the last viewer leaves or when the monthly transfer budget pauses video.

    cd house && npm install
    sh media/generate.sh        # once: builds media/house.y4m (see media/README.md for the font flag on Windows)
    cp .env.example .env        # API_URL, WEB_URL, HOUSE_KEY (same as api/.env), VIDEO_FILE, AUDIO_FILE
    npm start

The worker asks the API for a publisher token and hands it to the page by script before the page loads, so it is never part of a URL (and so never in a log line or an error message). `npm test` runs the start/stop rule. The `house` lines in `/hood` show each publish and stop.

## Deploy

Production is split three ways, so each part sits where it is cheapest to run:

| Part | Where | Hostname |
| --- | --- | --- |
| Web app (Next.js) | Vercel | `live.tahmidalavi.com` |
| API (two replicas), MongoDB, Redis, house worker | one small server (Oracle Cloud's free Arm VM), behind the shared Caddy in the `demo-host` repo | `api.tahmidalavi.com` |
| LiveKit node, which this repo's deploy stands up for both room kinds | a separate machine that already runs another LiveKit, so every port is moved | `livekit.tahmidalavi.com`, `turn.tahmidalavi.com` |

Files: `deploy/docker-compose.prod.yml`, `deploy/deploy.sh`, `deploy/.env.example` (API server), `deploy/livekit-node/` (LiveKit node), `deploy/smoke.mjs` (run from a laptop).

How the pieces are wired, because the API's proxy and cookie logic depend on it:

- The browser calls `api.tahmidalavi.com` directly, for HTTP, the socket and the event stream. The API allows exactly `WEB_ORIGIN` with credentials. Both hostnames share `tahmidalavi.com`, so the guest cookie counts as same-site and is sent. `/hood` needs no cookie; `/admin` needs its cookie, which a browser sends inside the portfolio's iframe only when the portfolio itself is on `tahmidalavi.com`.
- Caddy is on the host network. The API replicas publish on `127.0.0.1:4101` and `:4102` only. Docker shows Caddy to the containers as the network gateway (`10.241.1.1`), not as loopback, so compose sets `TRUST_PROXY=loopback, 10.241.1.1`. Without it every visitor would share one address and one rate limit. Caddy answers 404 for `/house/*`.
- MongoDB (single-node replica set) and Redis are on the compose network with no published ports.
- The house worker is on the host network so it can ask `127.0.0.1:4101` for its token, then opens the public `/house` page on Vercel. It needs `HOUSE_KEY` and `WEB_ORIGIN` from the environment.
- The LiveKit node runs the release binary under systemd as a throwaway user, capped at two cores and 512 MB. Its signal and metrics ports listen on loopback only; the machine's nginx terminates TLS for `livekit.tahmidalavi.com` and serves the byte counters at `/lr-metrics` to the API server's address alone. That is `LIVEKIT_METRICS_URL`. `install.sh` adds only its own files, one nginx site and four firewall rules commented `live-room`; `uninstall.sh` takes all of them out again.

| LiveKit node port | Use |
| --- | --- |
| 7980/tcp, loopback | signalling, behind nginx on 443 |
| 6790/tcp, loopback | metrics, behind nginx at `/lr-metrics` |
| 7891/tcp | media when UDP is blocked |
| 7892/udp | media, one port shared by every connection |
| 3479/udp | TURN |
| 44200-44300/udp | TURN relay |

Memory ceilings on the API server (`mem_limit`), in MB: MongoDB 448, Redis 160, each of two API replicas 288, house worker with Chromium 768; 1,952 in all.

`BUDGET_TB_MONTH` is the monthly outgoing transfer I allow this demo on the LiveKit node, in TB (1 in `.env.example`). It draws the budget line on `/admin/bandwidth` and sets the pause at 80% of it.

Two jobs in the API keep the limits real, because LiveKit leaves a connected viewer connected whatever their token says:

- The player asks `/renew` every 10 minutes, and a join or renew writes a proof that lapses after 15. Six video renewals a day per guest extend one join to about 70 minutes. After that a fresh join is needed, and fresh joins are limited only per network (12 an hour).
- `SeatSweep` runs every 10 s on one replica at a time. It asks LiveKit's room service (the Twirp API on `LIVEKIT_URL`, through the same nginx signal location, so no new port) who is in each video room and removes anyone but the house host whose proof has lapsed. While video is paused it removes every viewer but the house host. Audio rooms are never swept.

A viewer token can only subscribe and is hidden from the participant list, so a viewer cannot publish.

### Checklist (Tahmid)

Secrets are typed on the servers, never pasted into chat or committed.

1. Oracle Cloud: sign up, pick the home region (it cannot be changed later), then upgrade the account to Pay As You Go so an idle free VM is not reclaimed; set a $1 budget alert. Create an Ampere A1 VM, 2 OCPU / 12 GB, Ubuntu 24.04.
2. Oracle firewall, both layers. In the VCN security list allow 22/tcp from your own address, 80/tcp, 443/tcp and 443/udp. Oracle's Ubuntu image also blocks ports in `iptables`; on the VM add the same three web rules before the REJECT line and save them (`netfilter-persistent save`). Do this before installing Docker, so the saved rules do not include Docker's own chains.
3. On the VM: `ip route | grep 10.241` must print nothing, or the compose subnet collides (change it in `docker-compose.prod.yml`, the `TRUST_PROXY` line and this README). Install Docker with the compose plugin and git. Clone `demo-host` and `live-room` into `/srv`.
4. Cloudflare DNS for `tahmidalavi.com`, all DNS only (grey cloud), no AAAA records (see Known limits): `api` A to the Oracle VM, `livekit` and `turn` A to the LiveKit node, `live` CNAME to `cname.vercel-dns.com`.
5. API server: in `/srv/live-room` run `cp deploy/.env.example .env` and fill it in. `openssl rand -hex 32` makes a good value for each secret; run it on the server and paste straight into the file.
6. LiveKit node: copy `deploy/livekit-node/` there (only that folder; nothing else from this repo goes on that machine). As root, put the same key and secret as the API's `.env` in `/etc/live-room-livekit/keys.env` as `LIVEKIT_KEYS=<key>: <secret>` (the first run of the script creates the file and stops), then `sh install.sh <Oracle VM public IPv4>` (the public address from the Oracle console, not the private one `ip addr` shows on the VM, or nginx refuses the metrics to the API). It downloads LiveKit 1.13.11, checks its SHA-256, starts the service, adds the firewall rules, gets the certificate and enables the nginx site. A new site file that nginx rejects is swapped back for the previous one before anything reloads, and LiveKit restarts only when its binary, config or unit changed, since a restart drops everyone in every room. If that machine's provider also has a firewall in its panel, open the same four ports there: 7891/tcp, 7892/udp, 3479/udp, 44200-44300/udp.
7. `cd /srv/demo-host && docker compose up -d`.
8. `sh /srv/live-room/deploy/deploy.sh`. It stops if any name in `.env` is empty, builds the images, brings up `api-1` and then `api-2` (each waits for its health check, so one replica keeps serving), applies the Prisma schema and seeds the two house rooms. The API refuses to boot if a number in `.env` is not a number or `ADMIN_PASSWORD` is under 12 characters. The first build downloads a lot and takes several minutes.
9. Vercel: import `live-room`, Root Directory `web`, set `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_SOCKET_URL` to `https://api.tahmidalavi.com`, add the domain `live.tahmidalavi.com`.
10. From your laptop: `cd deploy && npm ci && node smoke.mjs https://live.tahmidalavi.com https://api.tahmidalavi.com`. Every line should say `ok`; the last line says `passed with warnings` if any line was a `WARN`. The LiveKit check requests `/rtc/validate` on `livekit.tahmidalavi.com` with a real token, so it also proves DNS, the certificate, nginx and the keys. A `WARN` on the LiveKit egress line is acceptable only while the house audio host is stopped; with it publishing, that line fails when the API cannot read `LIVEKIT_METRICS_URL`. A `WARN` on the video join means the transfer budget has paused video.
11. The real check: the phone on mobile data watches both rooms while a laptop has `/admin` open.

### Known limits

- TURN is UDP only (3479). There is no TURN/TLS because 443 belongs to nginx on the LiveKit node, so a network that blocks all UDP falls back to 7891/tcp and, if that is blocked too, cannot join a room.
- One API server and one LiveKit node: if either dies, that half of the demo is down. A LiveKit restart drops every viewer in both room kinds.
- The house worker reaches LiveKit and the web app through their public addresses, so it fails until DNS, the certificate and the Vercel deploy are in place.
- Every per-network limit (5 new guests and 12 joins an hour, 5 admin logins) is keyed on the visitor's address. IPv6 hands one subscriber a whole /64, so over IPv6 those limits would be per address out of billions. `api` stays A-only so every visitor arrives over IPv4; adding an AAAA record means keying the limits on the /64 first.
- Video can still be drained by many addresses. Each address gets 12 joins an hour, and a guest swept after about 70 minutes can simply join again, so someone with a pool of addresses can use the node's transfer far faster than one visitor. The pause at 80% of the monthly budget is what caps the cost; past it video stays off until the 1st.
- The video time limit is enforced by a 10 s sweep, not by the token, so a viewer can stay up to 10 s past the end of their proof. If the API cannot reach LiveKit's room service the sweep removes nobody and logs one line per tick.
- The budget counts only while the node's metrics are readable. If `LIVEKIT_METRICS_URL` is empty or nginx refuses it, nothing is added and video does not pause. The admin page says "not measured yet" only until the first reading; if the metrics break later, the measured line just shows a gap, and `smoke.mjs` fails the LiveKit egress line while the house audio host is publishing.
- LiveKit's counter restarts at zero when the node restarts, so the sample that spans a restart is dropped rather than guessed, and the bytes sent in that one 10 s slot are not counted.
