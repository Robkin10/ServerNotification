# Docker deployment

The Docker deployment uses this layout:

```text
/opt/telegramapp/
|-- app/                 # application source, Dockerfile, and private .env
|-- data/tracker.db      # persistent SQLite state and panel credentials
`-- compose.yml
```

## First install

1. Copy the project to `/opt/telegramapp` and create the private runtime file:

   ```sh
   cd /opt/telegramapp
   cp app/.env.example app/.env
   chmod 600 app/.env
   ```

2. Set strong `DASHBOARD_USER` and `DASHBOARD_PASS` values, plus
   `NOTIFICATION_TELEGRAM_BOT_TOKEN`, in `app/.env`. Do not commit or copy the
   file into the image.

3. The container runs as the non-root `node` user (UID/GID 1000). Ensure it can
   write the persistent database directory, then build and start it:

   ```sh
   sudo chown 1000:1000 data
   docker compose up -d --build
   ```

The dashboard is published only to `127.0.0.1:3000` by default. Put it behind a
TLS reverse proxy. If direct remote access is intentional, start it with
`TRACKER_BIND_ADDRESS=0.0.0.0 docker compose up -d` and protect the host
firewall accordingly. Use `TRACKER_PORT` to choose another host port.

Open `http://127.0.0.1:3000/login`, sign in, then add 3X-UI servers on the
**Servers** page.

## Existing database migration

For an older installation, stop its service before moving the state file. Move
the old `vless_tracker.db` to `data/tracker.db`; it is the same SQLite format.
Keep `app/.env` and `data/tracker.db` out of source-control and restrict their
permissions.

## Updating

Back up `app/.env` and `data/tracker.db`, then update the application source
and run:

```sh
docker compose up -d --build
```

Never remove `data/tracker.db` unless resetting all saved panel configuration,
client state, cached links, and notification history is intended.
