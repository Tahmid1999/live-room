I built Live Room to show a live-streaming backend end to end: video and audio rooms, chat, gifts paid from a coin wallet, and an admin view of bandwidth.
It is still being built, so this page will grow as the pieces land.

## Running LiveKit without Docker

Audio rooms need a LiveKit server. Copy `livekit.dev.example.yaml` to `livekit.dev.yaml`, put the same key and secret as `api/.env` under `keys`, then run the server binary against it:

    livekit-server --config livekit.dev.yaml

The API reads the bytes LiveKit has sent from `http://LIVEKIT_HOST:6789/metrics`, so `LIVEKIT_HOST` in `api/.env` is a bare host (`127.0.0.1`) and `LIVEKIT_URL` is `ws://127.0.0.1:7890`.
