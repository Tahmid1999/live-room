FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json next.config.ts ./
COPY app ./app
COPY lib ./lib
# NEXT_PUBLIC_SOCKET_URL is deliberately not set: inlined at build time, unset
# means the browser connects to the page's own origin, where Caddy serves
# /socket.io. next/font fetches the Google fonts during this step.
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3101
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
USER node
CMD ["node", "server.js"]
