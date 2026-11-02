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
