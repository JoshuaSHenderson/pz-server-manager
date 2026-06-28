# PZ Server Manager

Web-based management UI for a Project Zomboid dedicated server running in Docker.

Built with Node.js + Express. Runs as a sidecar Docker container alongside the PZ server container.

## Features

- **Dashboard** — server status, one-click Start / Stop / Restart, CPU / Memory / Disk stats
- **Mods** — install mods by Steam Workshop ID, remove mods, live download progress tracking
- **Players** — whitelist management, access level control, ban/unban
- **Logs** — live streaming server logs with filter and keyword coloring
- **Settings** — Pushover push notifications for server and player events

### Notification events

| Event | Description |
|---|---|
| Server start / stop / restart | Fires on UI action |
| Server crash | Background poll — detects unexpected container exit |
| Low disk space | Alerts when free space drops below configurable threshold |
| Workshop downloads complete | Fires when mod update queue drains to zero |
| Player joined | Parsed from PZ user log |
| Player left | Parsed from PZ user log |
| Player died | Parsed from PZ user log |
| Player kicked | Parsed from PZ user log |

## Requirements

- Docker with access to the host socket (`/var/run/docker.sock`)
- PZ server container named `zomboid`
- PZ data volume mounted at `/pz-data`
- PZ workshop volume mounted at `/workshop`

## Setup

Add to your existing PZ `docker-compose.yml`:

```yaml
services:
  mod-manager:
    build: ./mod-manager
    container_name: pz-mod-manager
    ports:
      - "7777:7777"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./workshop:/workshop
      - ./data:/pz-data
    restart: unless-stopped
    depends_on:
      - zomboid
```

Copy the `mod-manager/` directory into your PZ compose project, then:

```bash
docker compose build mod-manager
docker compose up -d mod-manager
```

Open `http://<server-ip>:7777`.

## Notifications

Configure Pushover credentials in the **Settings** tab of the UI. Credentials are stored in `/pz-data/notifications.json` (your data volume) — they are never baked into the image.

Get a Pushover account and app token at [pushover.net](https://pushover.net).

## File layout

```
mod-manager/
  Dockerfile
  package.json
  server.js        # Express API + background monitors
  public/
    index.html     # Single-page UI (vanilla JS, no build step)
```

## Notes

- The PZ server container must be named `zomboid` (or update `server.js`)
- Server config expected at `/pz-data/Server/servertest.ini`
- Whitelist DB at `/pz-data/db/servertest.db` (SQLite)
- Player event logs at `/pz-data/Logs/*_user.txt` (PZ B41 format)
- Workshop content at `/workshop/content/108600/`
- When installing mods via UI, SteamCMD downloads to `pz-dedicated/` dir inside the PZ container — manager copies to the mounted Steam workshop path automatically

## License

MIT
