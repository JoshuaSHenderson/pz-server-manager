FROM node:20-alpine
# tzdata: alpine ships no zone database, so a TZ= of "America/New_York" silently stays UTC
# without it — and the restart schedule runs on this container's wall clock.
RUN apk add --no-cache docker-cli sqlite tzdata
WORKDIR /app
COPY package.json .
RUN npm install
COPY . .
CMD ["node", "server.js"]
