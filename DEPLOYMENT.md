# Production deployment

The release package intentionally excludes `.env`, `vless_tracker.db`, `node_modules`, and tests.

## Install

1. Extract the package to a dedicated application directory on the server.
2. Install Node.js 20 LTS or newer.
3. Copy `.env.example` to `.env` and set at least:
   - `DASHBOARD_USER`
   - `DASHBOARD_PASS`
   - `NOTIFICATION_TELEGRAM_BOT_TOKEN`
   - `NOTIFICATION_TIME_ZONE=Asia/Yangon` (optional; this is the default)
4. Install locked production dependencies:

   ```sh
   npm ci --omit=dev
   ```

5. Start the service:

   ```sh
   npm start
   ```

6. Open `http://HOST:PORT/login`, sign in, then add the 3X-UI servers on the **Servers** page.

## Persistent data

The application creates `vless_tracker.db` beside `server.js`. Keep this file across upgrades because it contains server configuration, client notification state, and locally stored panel credentials. It is deliberately not included in the release ZIP.

If you are moving an existing installation, transfer the existing `.env` and `vless_tracker.db` separately through a secure channel, with file permissions restricted to the service account.

## Updating

Back up `.env` and `vless_tracker.db`, stop the service, replace only the application source files, run `npm ci --omit=dev`, then start the service again. Do not overwrite the existing database unless you intend to reset server configuration and notification history.
