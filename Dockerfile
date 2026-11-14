# Two stages, because the UI is now built rather than served as a single file.
#
# The build stage exists only to turn web/ into dist/. The runtime stage installs production
# dependencies alone — React, Vite and TypeScript never reach the running container.

FROM node:20-alpine AS build
WORKDIR /app
# package files first, so a source-only change does not re-run the install.
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY web ./web
RUN npm run build


FROM node:20-alpine
# docker-cli: this manager controls the game server's container.
# sqlite:     the player whitelist lives in the game's own SQLite database.
# tzdata:     alpine ships no zone database, so a TZ= of "America/New_York" silently stays UTC
#             without it — and the restart schedule runs on this container's wall clock.
RUN apk add --no-cache docker-cli sqlite tzdata

WORKDIR /app
COPY package.json package-lock.json ./
# `npm ci --omit=dev` rather than `npm install`: reproducible, and it leaves the build toolchain out.
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY lib ./lib
COPY src ./src
COPY --from=build /app/dist ./dist

# MANAGER_TOKEN pins the sign-in token. Left unset, one is generated on first run, persisted to
# /pz-data/manager-token and printed to this container's log.
CMD ["node", "server.js"]
