I built Live Room to show a live-streaming backend end to end: video and audio rooms, chat, gifts paid from a coin wallet, and an admin view of bandwidth.
It is still being built, so this page will grow as the pieces land.

## Running LiveKit without Docker

Audio rooms need a LiveKit server. Copy `livekit.dev.example.yaml` to `livekit.dev.yaml`, put the same key and secret as `api/.env` under `keys`, then run the server binary against it:

    livekit-server --config livekit.dev.yaml

The API reads the bytes LiveKit has sent from `http://LIVEKIT_HOST:6789/metrics`, so `LIVEKIT_HOST` in `api/.env` is a bare host (`127.0.0.1`) and `LIVEKIT_URL` is `ws://127.0.0.1:7890`.

## Running the phone web app

MongoDB (replica set) and Redis must already be up, with `api/.env` filled in. In dev set `WEB_ORIGIN=http://localhost:3130` there, because the socket connects to the API directly. Then, in three terminals:

    livekit-server --config livekit.dev.yaml
    cd api && npm run seed && npm run start:dev
    cd web && npm install && npm run dev

The app is at `http://localhost:3130`. It calls the API through a Next rewrite (`/api/*` to `127.0.0.1:4110`, override with `API_ORIGIN`), and the socket goes to `NEXT_PUBLIC_SOCKET_URL` (set in `web/.env.development`; leave it empty in production, where one proxy serves both).

The video room needs a real Agora App ID and certificate; without them the page says the video could not start and shows no picture. The audio room works against the local LiveKit server.

### Browser test

    cd web && npx playwright install chromium && npx playwright test viewer

Playwright starts LiveKit, the API and the web app if they are not already running (the first API start compiles, so allow a minute). The test clears the per-IP guest and join counters in Redis db 0 first and runs `npm run seed`, so it is safe to repeat.

## House hosts

The two house rooms are kept alive by a small worker in `house/` that drives headless Chromium with fake media and publishes from the page at `/house`. The audio room (LiveKit) is published from boot. The video room (Agora) is published only while someone is watching, and stopped 60 s after the last viewer leaves or when the free Agora minutes pause.

    cd house && npm install
    sh media/generate.sh        # once: builds media/house.y4m (see media/README.md for the font flag on Windows)
    cp .env.example .env        # API_URL, WEB_URL, HOUSE_KEY (same as api/.env), VIDEO_FILE, AUDIO_FILE
    npm start

The worker asks the API for a publisher token and hands it to the page by script before the page loads, so it is never part of a URL (and so never in a log line or an error message). `npm test` runs the start/stop rule. The `house` lines in `/hood` show each publish and stop.

## Deploy

Production is one VPS shared with the other demos. A separate repo, `demo-host`, runs the one Caddy that owns ports 80 and 443 and routes by hostname; this repo only brings its own containers. Files: `deploy/docker-compose.prod.yml`, `deploy/livekit.yaml`, `deploy/deploy.sh`, `deploy/smoke.mjs`, `deploy/.env.example`.

How the pieces are wired, because the API's proxy and cookie logic depend on it:

- Caddy is on the host network. The API replicas (`127.0.0.1:4101` and `:4102`) and the web app (`127.0.0.1:3101`) publish on loopback only. Docker shows Caddy to the containers as the network gateway (`10.241.1.1`), not as loopback, so compose sets `TRUST_PROXY=loopback, 10.241.1.1`. Without it every visitor would share one address and one rate limit.
- MongoDB (single-node replica set) and Redis are on the compose network with no published ports.
- LiveKit is on the host network so it can serve its UDP range. Its signal and metrics ports listen on loopback and on the compose gateway `10.241.1.1` and nowhere public; that is how the API containers read the measured egress (`LIVEKIT_HOST=10.241.1.1`) without opening 6789. The subnet in `docker-compose.prod.yml`, `bind_addresses` in `livekit.yaml` and these two settings have to agree.
- The house worker is on the host network too: it opens `http://localhost:3101/house`, which Chromium treats as a secure context without TLS, and asks `127.0.0.1:4101` for its token. It needs only `HOUSE_KEY` from the environment.
- The browser build is same-origin: `NEXT_PUBLIC_SOCKET_URL` is not set, so the socket connects to the page's own origin and Caddy sends `/socket.io` to the API. The `/api` rewrite in `next.config.ts` exists only in development.

Memory ceilings (`mem_limit`), in MB: MongoDB 448, Redis 160, each of two API replicas 288, web 352, LiveKit 192, house worker with Chromium 768. They add up to 2,496, which is the 2.5 GB Live Room is allowed on the box.

### Host

| | |
| --- | --- |
| Provider and plan | to fill in after buying |
| Price per month | |
| RAM / vCPU | |
| Monthly transfer included | |

`BUDGET_TB_MONTH` in the server's `.env` is the transfer line of that table, in TB.

### Checklist (Tahmid)

Secrets are typed on the server, never pasted into chat or committed.

1. Buy the VPS: EU (Germany or Finland), 4 vCPU / 8 GB class, under $10 a month. Fill in the table above.
2. Create the Agora project. Enable co-host authentication on it (otherwise a viewer's token could publish) and note the App ID and the primary certificate.
3. In Cloudflare add three A records to the VPS address, all DNS only (grey cloud): `live`, `livekit`, `turn` under `tahmidalavi.com`.
4. Firewall at the provider: allow 80/tcp, 443/tcp, 443/udp (Caddy's HTTP/3; closing it only costs browsers the faster protocol), 3478/udp, 7881/tcp and 50000-50100/udp, plus 22/tcp from your own address for SSH. Nothing else. If the box also runs `ufw`, containers need one more rule to reach LiveKit's metrics: `ufw allow from 10.241.1.0/24 to 10.241.1.1 port 6789 proto tcp`.
5. On the server: run `ip route | grep 10.241`; it must print nothing, or the provider's private network collides with the compose subnet (change it in `docker-compose.prod.yml`, `livekit.yaml` and the README before deploying). Install Docker with the compose plugin and git. Clone `demo-host` and `live-room` (branch `main` after the merge) into `/srv`.
6. In `/srv/live-room` run `cp deploy/.env.example .env` and fill it in with an editor. `openssl rand -hex 32` makes a good value for each secret; run it on the server and paste straight into the file.
7. `cd /srv/demo-host && docker compose up -d`.
8. `sh /srv/live-room/deploy/deploy.sh`. It stops if any name in `.env` is empty, builds the images, waits for the health checks, applies the Prisma schema and seeds the two house rooms. The first build downloads a lot and takes several minutes.
9. From your laptop: `cd deploy && npm ci && node smoke.mjs https://live.tahmidalavi.com`. Every line should say `ok`. The LiveKit check requests `/rtc/validate` on `livekit.tahmidalavi.com` with a real token, so it also proves DNS, the certificate, Caddy and the keys. A `WARN` on the LiveKit egress line is acceptable only while the house audio host is stopped; with it publishing, that line fails when the API cannot read the metrics port.
10. The real check: the phone on mobile data watches both rooms while a laptop has `/admin` open.

If LiveKit exits at boot with an address error, the compose network did not exist yet; `docker compose -f deploy/docker-compose.prod.yml --env-file .env up -d` again.

### Known limits

- TURN is UDP only (3478). There is no TURN/TLS because 443 belongs to Caddy, so a network that blocks all UDP falls back to 7881/tcp and, if that is blocked too, cannot join an audio room.
- One VPS, one LiveKit node: if the box dies, the demo is down.
- The house worker reaches LiveKit through the public address, so it fails until DNS and the certificate for `livekit.tahmidalavi.com` are in place.
