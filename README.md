# 3X-UI expiry & change tracker

A Node.js service that reads VLESS clients from one or more 3X-UI panels on a schedule, stores their last observed state in SQLite, and notifies Telegram-bound users of expirations and configuration changes. It also serves a protected dashboard.

## Setup

1. Copy `.env.example` to `.env`; set `DASHBOARD_USER`, `DASHBOARD_PASS`, and `NOTIFICATION_TELEGRAM_BOT_TOKEN` for a dedicated outbound-only notification bot. Do not commit `.env`.
2. Change `DASHBOARD_USER` and `DASHBOARD_PASS`; the documented defaults are for local development only.
3. Run `npm install`, then `npm start`.
4. Open `http://HOST:PORT`, authenticate, and use **Add Server details** to create each panel connection. Enter a group name to organize related servers.

Open the login screen at `/login` and sign in with `DASHBOARD_USER` and `DASHBOARD_PASS`. Authentication uses an HttpOnly, SameSite session cookie that expires after eight hours; protected write requests also require a per-session CSRF token. Each server record stores its panel base URL, bearer token, username, and password in SQLite; secrets are accepted only by authenticated write routes and are never returned to the browser. Server details can be edited, paused, or deleted from the dashboard. Deleting a server also deletes only that server's stored client state.

Every client-state key is scoped to its server, so the same email or Telegram ID on two panels is tracked independently. All valid VLESS clients are stored, including clients without a Telegram binding. Each audit refreshes `tgId`, expiry, and enabled state from 3X-UI automatically; adding an enabled server also starts an immediate first sync. Notifications include the originating group/server. `NOTIFICATION_TELEGRAM_BOT_TOKEN` must be the token for a separate bot (for example `cus_noti_bot`), not the bot connected to 3X-UI (for example `kre_az_bot`). By default, the separate bot also long-polls private `/start` commands and replies with the linked account email, status, and expiration date. Set `TELEGRAM_WELCOME_ENABLED=false` to disable this behavior. Run only one app instance for the bot and do not configure a Telegram webhook at the same time. The tracker enumerates with `GET /panel/api/clients/list`, then obtains the authoritative `tgId`, `expiryTime`, and `enable` fields per email through `GET /panel/api/clients/get/:email`; it is not a proxy and has no panel write operations.

Existing single-server environment variables are supported as a one-time import only: on startup, if no database servers exist and all four legacy `THREEXUI_*` connection values are set, they are imported as **Default / Imported default server**. Subsequent changes should be made in the dashboard.

`CHECK_INTERVAL_CRON` defaults to every two minutes. The initial audit begins after the dashboard starts; a failed panel call is shown as a sanitized dashboard error and is retried by the next scheduled run. For expiring keys, the tracker sends one reminder in each final UTC-day bucket with 3, 2, and 1 day remaining, including the remaining-day count. It records the reminder day in SQLite so the frequent audit schedule cannot duplicate a day's reminder.

The dashboard's **Send test notification** button asks for confirmation, then sends one labeled test message to each distinct valid `tgId` within each enabled server. The button is a fixed authenticated action, not a free-form messaging endpoint, and returns only aggregate delivery counts.

## Tests

Run `npm test`. Tests use local mocks for panel authentication, login sessions, the tracker engine, and dashboard routes. They do not contact a real panel or Telegram and never modify VPN clients.
