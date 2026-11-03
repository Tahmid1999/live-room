# One stage on purpose. `prisma db push` and the compiled seed run inside this
# container at deploy time, so the prisma CLI (a dev dependency) has to stay;
# pruning to production dependencies would take it, and the generated client
# with it, out of the image.
FROM node:22-bookworm-slim

# The slim image has no openssl, and prisma's query engine needs it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

ENV NODE_ENV=production
USER node
CMD ["node", "dist/main"]
