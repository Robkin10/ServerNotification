require('dotenv').config();

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const cron = require('node-cron');
const {
  claimLegacyClientStates,
  closeDatabase,
  createTrackedServer,
  deleteTrackedServer,
  getClientSummary,
  initializeDatabase,
  listClientStates,
  listServerGroups,
  listServerSummaries,
  listTrackedServers,
  updateTrackedServer
} = require('./database');
const { normalizeBaseUrl } = require('./panelApi');
const { TrackerEngine } = require('./trackerEngine');

class InputError extends Error {}

const SESSION_COOKIE_NAME = 'tracker_session';
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;

function dashboardCredentials(environment = process.env) {
  return {
    username: environment.DASHBOARD_USER?.trim() || 'admin',
    password: environment.DASHBOARD_PASS || 'admin123'
  };
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left ?? ''));
  const rightBuffer = Buffer.from(String(right ?? ''));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function sessionTokenFrom(request) {
  const cookieHeader = request.get('Cookie') || '';
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]+)`));
  return match ? match[1] : null;
}

function createSessionStore({ now = () => Date.now(), maxAgeMs = SESSION_MAX_AGE_MS } = {}) {
  const sessions = new Map();

  function pruneExpired() {
    const currentTime = now();
    for (const [token, session] of sessions) {
      if (session.expiresAt <= currentTime) sessions.delete(token);
    }
  }

  return {
    create(username) {
      pruneExpired();
      const token = crypto.randomBytes(32).toString('base64url');
      const session = {
        username,
        csrfToken: crypto.randomBytes(32).toString('base64url'),
        expiresAt: now() + maxAgeMs
      };
      sessions.set(token, session);
      return { token, ...session };
    },
    get(token) {
      if (!token) return undefined;
      const session = sessions.get(token);
      if (!session || session.expiresAt <= now()) {
        sessions.delete(token);
        return undefined;
      }
      return session;
    },
    delete(token) {
      if (token) sessions.delete(token);
    }
  };
}

function sessionCookieOptions(request, environment) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: environment.SESSION_COOKIE_SECURE === 'true' || request.secure,
    maxAge: SESSION_MAX_AGE_MS,
    path: '/'
  };
}

function parsePort(value) {
  if (value === undefined || value === '') return 3000;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  return port;
}

function serialiseClient(row, now) {
  const expiryTime = Number(row.expiry_time) || 0;
  const enabled = Number(row.is_enabled) === 1;
  const expired = expiryTime > 0 && expiryTime <= now;
  const client = {
    id: row.client_id || row.vless_id,
    email: row.email || '(unnamed)',
    telegramId: row.telegram_id || null,
    expiryTime,
    enabled,
    expired,
    expiryNotified: Number(row.is_expired_notified) === 1
  };
  if (row.server_id !== undefined && row.server_id !== null) client.serverId = Number(row.server_id);
  if (row.server_name) client.serverName = row.server_name;
  if (row.group_name) client.serverGroup = row.group_name;
  return client;
}

function serialiseServer(server) {
  return {
    id: Number(server.id),
    groupId: Number(server.group_id),
    groupName: server.group_name,
    name: server.name,
    baseUrl: server.base_url,
    username: server.username,
    enabled: Number(server.is_enabled) === 1,
    createdAt: Number(server.created_at) || null,
    updatedAt: Number(server.updated_at) || null,
    credentialsConfigured: true
  };
}

function serialiseInitialSync(result) {
  if (!result || typeof result !== 'object') return null;
  return {
    success: result.success === true,
    skipped: result.skipped === true,
    clientsFetched: Number(result.clientsFetched) || 0,
    clientsTracked: Number(result.clientsTracked) || 0,
    clientDetailsFailed: Number(result.clientDetailsFailed) || 0
  };
}

function requireDashboardRequest(request, response) {
  // Cross-site forms cannot set either header. The CSRF token is unique to the
  // authenticated, HttpOnly-cookie-backed session.
  if (
    request.get('X-Requested-With') === 'XMLHttpRequest' &&
    request.session &&
    safeEqual(request.get('X-CSRF-Token'), request.session.csrfToken)
  ) return true;
  response.status(403).json({ success: false, message: 'Valid dashboard request headers are required.' });
  return false;
}

function valueFrom(payload, field, label, { required = true, maxLength = 4_000, trim = true } = {}) {
  if (!Object.hasOwn(payload, field)) {
    if (required) throw new InputError(`${label} is required.`);
    return undefined;
  }
  if (typeof payload[field] !== 'string') throw new InputError(`${label} must be text.`);
  const value = trim ? payload[field].trim() : payload[field];
  if (required && !value.trim()) throw new InputError(`${label} is required.`);
  if (value.length > maxLength) throw new InputError(`${label} is too long.`);
  return value;
}

/** Validate and normalize browser input before it is allowed into SQLite. */
function serverInput(payload, { update = false } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new InputError('Server details must be a JSON object.');
  }

  const groupName = valueFrom(payload, 'groupName', 'Server group', { required: !update, maxLength: 100 });
  const name = valueFrom(payload, 'name', 'Server name', { required: !update, maxLength: 100 });
  const baseUrlInput = valueFrom(payload, 'baseUrl', 'Base URL', { required: !update, maxLength: 2_000 });
  let baseUrl;
  if (baseUrlInput !== undefined) {
    if (!baseUrlInput) throw new InputError('Base URL is required.');
    try {
      baseUrl = normalizeBaseUrl(baseUrlInput);
    } catch {
      throw new InputError('Base URL must be a valid HTTP or HTTPS URL without embedded credentials.');
    }
  }

  const username = valueFrom(payload, 'username', 'Username', { required: !update, maxLength: 500 });
  const bearerTokenInput = valueFrom(payload, 'bearerToken', 'Bearer token', {
    required: !update,
    maxLength: 8_000,
    trim: true
  });
  const passwordInput = valueFrom(payload, 'password', 'Password', {
    required: !update,
    maxLength: 4_000,
    trim: false
  });
  const bearerToken = update && bearerTokenInput !== undefined && !bearerTokenInput ? undefined : bearerTokenInput;
  const password = update && passwordInput !== undefined && !passwordInput ? undefined : passwordInput;

  let enabled;
  if (Object.hasOwn(payload, 'enabled')) {
    if (typeof payload.enabled !== 'boolean') throw new InputError('Enabled must be true or false.');
    enabled = payload.enabled;
  } else if (!update) {
    enabled = true;
  }

  return {
    groupName,
    name,
    baseUrl,
    bearerToken,
    username,
    password,
    enabled
  };
}

function serverIdFrom(request) {
  const serverId = Number(request.params.serverId);
  if (!Number.isSafeInteger(serverId) || serverId < 1) throw new InputError('Invalid server id.');
  return serverId;
}

function sendMutationError(response, error) {
  if (error instanceof InputError) {
    response.status(400).json({ success: false, message: error.message });
    return;
  }
  if (error?.code === 'SQLITE_CONSTRAINT') {
    response.status(409).json({ success: false, message: 'A server with that name already exists in this group.' });
    return;
  }
  response.status(500).json({ success: false, message: 'Server details could not be saved.' });
}

function createApp({
  engine = new TrackerEngine(),
  database = {
    createTrackedServer,
    deleteTrackedServer,
    getClientSummary,
    listClientStates,
    listServerGroups,
    listServerSummaries,
    updateTrackedServer
  },
  sessionStore = createSessionStore(),
  environment = process.env
} = {}) {
  const app = express();
  const credentials = dashboardCredentials(environment);

  app.disable('x-powered-by');
  app.use((request, response, next) => {
    response.set({
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY'
    });
    next();
  });

  app.use(express.json({ limit: '16kb', type: 'application/json' }));

  app.get('/login', (request, response) => {
    if (sessionStore.get(sessionTokenFrom(request))) {
      response.redirect('/');
      return;
    }
    response.sendFile(path.join(__dirname, 'public', 'login.html'));
  });

  app.get('/login.css', (request, response) => {
    response.sendFile(path.join(__dirname, 'public', 'login.css'));
  });

  app.get('/login.js', (request, response) => {
    response.sendFile(path.join(__dirname, 'public', 'login.js'));
  });

  app.post('/api/auth/login', (request, response) => {
    const username = request.body?.username;
    const password = request.body?.password;
    const validCredentials = typeof username === 'string' && typeof password === 'string' &&
      safeEqual(username, credentials.username) && safeEqual(password, credentials.password);
    if (!validCredentials) {
      response.status(401).json({ success: false, message: 'Invalid username or password.' });
      return;
    }
    const session = sessionStore.create(credentials.username);
    response.cookie(SESSION_COOKIE_NAME, session.token, sessionCookieOptions(request, environment));
    response.json({
      success: true,
      data: { username: session.username, csrfToken: session.csrfToken }
    });
  });

  app.use((request, response, next) => {
    const session = sessionStore.get(sessionTokenFrom(request));
    if (session) {
      request.session = session;
      next();
      return;
    }
    if (request.path.startsWith('/api/')) {
      response.status(401).json({ success: false, message: 'Authentication required.' });
      return;
    }
    response.redirect('/login');
  });

  app.get('/api/auth/session', (request, response) => {
    response.json({
      success: true,
      data: { username: request.session.username, csrfToken: request.session.csrfToken }
    });
  });

  app.post('/api/auth/logout', (request, response) => {
    if (!requireDashboardRequest(request, response)) return;
    sessionStore.delete(sessionTokenFrom(request));
    response.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    response.json({ success: true });
  });

  app.get('/api/dashboard', async (request, response) => {
    try {
      const now = Date.now();
      const [summary, rows] = await Promise.all([
        database.getClientSummary(now),
        database.listClientStates()
      ]);
      response.json({
        success: true,
        data: {
          generatedAt: new Date(now).toISOString(),
          summary,
          tracker: engine.getStatus(),
          clients: rows.map((row) => serialiseClient(row, now))
        }
      });
    } catch {
      response.status(500).json({
        success: false,
        message: 'Dashboard data is temporarily unavailable.'
      });
    }
  });

  app.get('/api/servers', async (request, response) => {
    try {
      const [servers, groups] = await Promise.all([
        database.listServerSummaries(),
        database.listServerGroups()
      ]);
      response.json({
        success: true,
        data: {
          servers: servers.map(serialiseServer),
          groups: groups.map((group) => ({
            id: Number(group.id), name: group.name, serverCount: Number(group.server_count) || 0
          }))
        }
      });
    } catch {
      response.status(500).json({ success: false, message: 'Server details are temporarily unavailable.' });
    }
  });

  app.post('/api/servers', async (request, response) => {
    if (!requireDashboardRequest(request, response)) return;
    try {
      const server = await database.createTrackedServer(serverInput(request.body));
      let initialSync = null;
      if (Number(server.is_enabled) === 1 && typeof engine.runAudit === 'function') {
        try {
          initialSync = serialiseInitialSync(await engine.runAudit({ serverIds: [server.id] }));
        } catch {
          initialSync = { success: false, skipped: false, clientsFetched: 0, clientsTracked: 0, clientDetailsFailed: 0 };
        }
      }
      response.status(201).json({
        success: true,
        data: { server: serialiseServer(server), initialSync }
      });
    } catch (error) {
      sendMutationError(response, error);
    }
  });

  app.put('/api/servers/:serverId', async (request, response) => {
    if (!requireDashboardRequest(request, response)) return;
    try {
      const server = await database.updateTrackedServer(serverIdFrom(request), serverInput(request.body, { update: true }));
      if (!server) {
        response.status(404).json({ success: false, message: 'Server not found.' });
        return;
      }
      response.json({ success: true, data: { server: serialiseServer(server) } });
    } catch (error) {
      sendMutationError(response, error);
    }
  });

  app.delete('/api/servers/:serverId', async (request, response) => {
    if (!requireDashboardRequest(request, response)) return;
    try {
      const deleted = await database.deleteTrackedServer(serverIdFrom(request));
      if (!deleted) {
        response.status(404).json({ success: false, message: 'Server not found.' });
        return;
      }
      response.json({ success: true, message: 'Server and its stored client state were removed.' });
    } catch (error) {
      sendMutationError(response, error);
    }
  });

  app.get('/api/health', (request, response) => {
    const tracker = engine.getStatus();
    response.status(tracker.lastError ? 503 : 200).json({
      success: !tracker.lastError,
      tracker: {
        running: tracker.running,
        lastSuccessAt: tracker.lastSuccessAt,
        lastError: tracker.lastError
      }
    });
  });

  app.post('/api/notifications/test', async (request, response) => {
    if (!requireDashboardRequest(request, response)) return;
    try {
      const result = await engine.sendTestNotifications();
      if (result.skipped) {
        response.status(409).json({ success: false, message: 'A test notification run is already in progress.' });
        return;
      }
      response.json({
        success: result.success,
        message: `Test notification run complete: ${result.sent} delivered, ${result.failed} failed.`,
        result: {
          recipients: result.recipients,
          sent: result.sent,
          failed: result.failed,
          detailFailures: result.detailFailures,
          ...(result.serversFailed === undefined ? {} : { serversFailed: result.serversFailed })
        }
      });
    } catch {
      response.status(502).json({ success: false, message: 'Test notifications could not be sent.' });
    }
  });

  app.use(express.static(path.join(__dirname, 'public'), {
    index: false,
    etag: true,
    maxAge: '1h'
  }));

  app.get('/servers', (request, response) => {
    response.sendFile(path.join(__dirname, 'public', 'servers.html'));
  });

  app.get('/', (request, response) => {
    response.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  app.use('/api', (request, response) => {
    response.status(404).json({ success: false, message: 'API endpoint not found.' });
  });

  return app;
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/** Import the old single-panel .env setup once, only when no DB servers exist. */
async function importEnvironmentServer(environment, database = {
  claimLegacyClientStates,
  listServerSummaries,
  createTrackedServer
}) {
  const servers = await database.listServerSummaries();
  if (servers.length) return false;
  const fields = ['THREEXUI_BASE_URL', 'THREEXUI_BEARER_TOKEN', 'THREEXUI_USERNAME', 'THREEXUI_PASSWORD'];
  const values = Object.fromEntries(fields.map((field) => [field, environment[field]]));
  if (fields.some((field) => !String(values[field] || '').trim() || /^replace-with-/i.test(String(values[field]).trim()))) {
    return false;
  }
  let baseUrl;
  try {
    baseUrl = normalizeBaseUrl(String(values.THREEXUI_BASE_URL));
  } catch {
    return false;
  }
  const server = await database.createTrackedServer({
    groupName: 'Default',
    name: 'Imported default server',
    baseUrl,
    bearerToken: String(values.THREEXUI_BEARER_TOKEN).trim(),
    username: String(values.THREEXUI_USERNAME).trim(),
    password: String(values.THREEXUI_PASSWORD),
    enabled: true
  });
  if (typeof database.claimLegacyClientStates === 'function') {
    await database.claimLegacyClientStates(server.id);
  }
  return true;
}

async function start({ environment = process.env } = {}) {
  const cronExpression = environment.CHECK_INTERVAL_CRON || '*/2 * * * *';
  if (!cron.validate(cronExpression)) {
    throw new Error(`Invalid CHECK_INTERVAL_CRON expression: ${cronExpression}`);
  }

  const port = parsePort(environment.PORT);
  const host = environment.HOST?.trim() || '127.0.0.1';
  await initializeDatabase();
  await importEnvironmentServer(environment);

  const engine = new TrackerEngine();
  const app = createApp({ engine, environment });
  const server = http.createServer(app);
  await listen(server, port, host);

  const task = cron.schedule(cronExpression, () => {
    engine.runAudit();
  });
  engine.runAudit();

  const address = server.address();
  console.log(`Dashboard listening on http://${address.address}:${address.port}`);

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received; stopping dashboard.`);
    task.stop();
    server.close(() => {
      closeDatabase()
        .catch(() => console.error('Failed to close the tracker database.'))
        .finally(() => process.exit(0));
    });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  return { app, engine, server, task };
}

if (require.main === module) {
  start().catch((error) => {
    console.error(`Unable to start dashboard: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  createApp,
  dashboardCredentials,
  importEnvironmentServer,
  parsePort,
  serialiseServer,
  serverInput,
  start
};
