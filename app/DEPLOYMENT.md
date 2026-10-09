# Docker deployment

The CI/CD deployment uses this layout:

```text
/opt/telegramapp/
|-- app/                 # application source, Dockerfile, and private .env
|-- data/tracker.db      # persistent SQLite state and panel credentials
`-- compose.yml
```

## First install

1. Copy `compose.yml` to `/opt/telegramapp` and create the private runtime
   directories. The application source and `Dockerfile` are used only by
   GitHub Actions; the server runs the published image.

   ```sh
   cd /opt/telegramapp
   install -d -m 700 app data
   # Transfer a prepared environment file through a secure channel.
   cp /secure/location/telegram-tracker.env app/.env
   chmod 600 app/.env
   ```

2. Set strong `DASHBOARD_USER` and `DASHBOARD_PASS` values, plus
   `NOTIFICATION_TELEGRAM_BOT_TOKEN`, in `app/.env`. Do not commit or copy the
   file into the image.

3. The container runs as the non-root `node` user (UID/GID 1000). Ensure it can
   write the persistent database directory, then pull and start the image:

   ```sh
   sudo chown 1000:1000 data
   export TRACKER_ENV_FILE=/opt/telegramapp/app/.env
   export DOCKER_IMAGE=robkin/3xui-telegrambot
   export IMAGE_TAG=latest
   docker compose pull tracker
   docker compose up -d --no-build
   ```

   If the Docker Hub repository is private, run `docker login` once on the
   Ubuntu server with credentials that can pull the image.

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

## CI/CD

`.github/workflows/ci-cd.yml` runs only after a push to `main` (or a manual
workflow dispatch). It tests the app, pushes both `latest` and an immutable
`sha-<commit>` image tag to Docker Hub, then deploys that immutable tag to the
server. The deployment never copies, overwrites, or deletes `app/.env` or
`data/tracker.db`.

Configure the following GitHub Actions secrets before merging to `main`:

| Secret | Purpose |
| --- | --- |
| `DOCKERHUB_USERNAME` | Docker Hub account allowed to push the image |
| `DOCKERHUB_TOKEN` | Docker Hub access token with push permission |
| `DEPLOY_HOST` | Ubuntu server hostname or IP address |
| `DEPLOY_USER` | SSH user that can run Docker Compose in `/opt/telegramapp` |
| `DEPLOY_SSH_PRIVATE_KEY` | Private deployment key for that SSH user |
| `DEPLOY_KNOWN_HOSTS` | Pinned `known_hosts` entry for the Ubuntu server |

Optionally set the repository variable `DOCKERHUB_IMAGE` to a different image
name. The default is `robkin/3xui-telegrambot`.

Use a protected GitHub `production` environment and require approval for its
deployment job. Add the deployment public key to the server user's
`~/.ssh/authorized_keys`; do not allow password authentication or disable SSH
host-key checking.

Never remove `data/tracker.db` unless resetting all saved panel configuration,
client state, cached links, and notification history is intended.
