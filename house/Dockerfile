# The tag has to match the playwright version in package.json: the image ships
# the browser build that exact release drives.
FROM mcr.microsoft.com/playwright:v1.64.1-noble

# ffmpeg and a font are only here to build the test card; the raw video is too
# big to keep in git, so it is generated in the image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

COPY media /media
RUN sh /media/generate.sh

# Run with `init: true` in compose (or `docker run --init`): Chromium spawns
# helper processes that need a PID 1 which reaps them.
ENV VIDEO_FILE=/media/house.y4m AUDIO_FILE=/media/house.wav
CMD ["node", "dist/main.js"]
