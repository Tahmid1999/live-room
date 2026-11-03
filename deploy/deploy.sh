#!/bin/sh
# Run on the VPS from anywhere: sh /srv/live-room/deploy/deploy.sh
# Pulls, rebuilds what changed and brings it up one API replica at a time,
# then makes sure the collection indexes exist (the unique tapId index is what
# keeps a repeated tap from being charged twice) and the two house rooms are there.
set -eu
cd "$(dirname "$0")/.."

[ -f .env ] || { echo ".env is missing; copy deploy/.env.example and fill it in" >&2; exit 1; }
for name in $(grep -oE '^[A-Z][A-Z0-9_]*' deploy/.env.example); do
  grep -q "^$name=." .env || { echo "$name is empty or missing in .env" >&2; exit 1; }
done

compose="docker compose -f deploy/docker-compose.prod.yml --env-file .env"

git pull --ff-only
$compose build
$compose up -d --wait mongo redis livekit web
# One replica at a time: Caddy's health check takes the restarting one out and
# sends everything to the other, so a deploy never drops every socket at once.
# --no-deps so bringing up a replica does not recreate what it depends on.
for api in api-1 api-2; do
  $compose up -d --no-deps --wait "$api"
done
$compose up -d --wait house
$compose exec -T api-1 node_modules/.bin/prisma db push --skip-generate
$compose exec -T api-1 node dist/seed.js
