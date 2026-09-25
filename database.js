const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// Keep the database next to the application so the service has a predictable state file.
const databasePath = path.join(__dirname, 'vless_tracker.db');
const db = new sqlite3.Database(databasePath);

function run(sql, parameters = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, parameters, function onRun(error) {
      if (error) return reject(error);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, parameters = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, parameters, (error, row) => (error ? reject(error) : resolve(row)));
  });
}

function all(sql, parameters = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, parameters, (error, rows) => (error ? reject(error) : resolve(rows || [])));
  });
}

async function tableExists(name) {
  return Boolean(await get(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    [name]
  ));
}

async function createClientStateTable() {
  await run(`CREATE TABLE IF NOT EXISTS client_state (
    server_id INTEGER NOT NULL,
    client_id TEXT NOT NULL,
    telegram_id TEXT,
    email TEXT,
    expiry_time INTEGER,
    is_enabled INTEGER,
    is_expired_notified INTEGER DEFAULT 0,
    last_expiry_reminder_day TEXT,
    PRIMARY KEY (server_id, client_id)
  )`);
  await run('CREATE INDEX IF NOT EXISTS client_state_server_idx ON client_state(server_id)');
}

/**
 * Older versions used an email-only primary key, which cannot distinguish the
 * same customer on two panels. Preserve those rows while moving to a
 * server-scoped key. Legacy rows remain detached until an administrator adds
 * the matching server; they are never mixed into a new server's state.
 */
async function migrateClientStateTable() {
  if (!await tableExists('client_state')) {
    await createClientStateTable();
    return;
  }

  const columns = await all('PRAGMA table_info(client_state)');
  if (columns.some((column) => column.name === 'server_id') && columns.some((column) => column.name === 'client_id')) {
    await run('CREATE INDEX IF NOT EXISTS client_state_server_idx ON client_state(server_id)');
    return;
  }

  const hasReminderColumn = columns.some((column) => column.name === 'last_expiry_reminder_day');
  await run('BEGIN IMMEDIATE');
  try {
    await run('ALTER TABLE client_state RENAME TO client_state_legacy');
    await createClientStateTable();
    await run(
      `INSERT INTO client_state (
        server_id, client_id, telegram_id, email, expiry_time, is_enabled,
        is_expired_notified, last_expiry_reminder_day
      )
      SELECT 0, vless_id, telegram_id, email, expiry_time, is_enabled,
        is_expired_notified, ${hasReminderColumn ? 'last_expiry_reminder_day' : 'NULL'}
      FROM client_state_legacy`
    );
    await run('DROP TABLE client_state_legacy');
    await run('COMMIT');
  } catch (error) {
    await run('ROLLBACK').catch(() => {});
    throw error;
  }
}

/** Create all persistent server configuration and server-scoped client state. */
async function initializeDatabase() {
  await run(`CREATE TABLE IF NOT EXISTS server_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    created_at INTEGER NOT NULL
  )`);
  await run(`CREATE TABLE IF NOT EXISTS tracked_servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    bearer_token TEXT NOT NULL,
    username TEXT NOT NULL,
    password TEXT NOT NULL,
    is_enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (group_id) REFERENCES server_groups(id) ON DELETE RESTRICT,
    UNIQUE (group_id, name COLLATE NOCASE)
  )`);
  await run('CREATE INDEX IF NOT EXISTS tracked_servers_group_idx ON tracked_servers(group_id)');
  await migrateClientStateTable();
}

function normaliseName(value) {
  return String(value ?? '').trim();
}

async function findOrCreateServerGroup(groupName) {
  const name = normaliseName(groupName);
  const existing = await get('SELECT id, name FROM server_groups WHERE name = ? COLLATE NOCASE', [name]);
  if (existing) return existing;
  const result = await run('INSERT INTO server_groups (name, created_at) VALUES (?, ?)', [name, Date.now()]);
  return { id: result.lastID, name };
}

/** Server configurations for audits. This intentionally includes credentials and must never be sent to the browser. */
async function listTrackedServers() {
  return all(`SELECT
      s.id, s.group_id, g.name AS group_name, s.name, s.base_url,
      s.bearer_token, s.username, s.password, s.is_enabled
    FROM tracked_servers s
    JOIN server_groups g ON g.id = s.group_id
    WHERE s.is_enabled = 1
    ORDER BY g.name COLLATE NOCASE ASC, s.name COLLATE NOCASE ASC`);
}

/** Safe server directory for the dashboard; credentials never leave this module. */
async function listServerSummaries() {
  return all(`SELECT
      s.id, s.group_id, g.name AS group_name, s.name, s.base_url, s.username,
      s.is_enabled, s.created_at, s.updated_at
    FROM tracked_servers s
    JOIN server_groups g ON g.id = s.group_id
    ORDER BY g.name COLLATE NOCASE ASC, s.name COLLATE NOCASE ASC`);
}

async function listServerGroups() {
  return all(`SELECT g.id, g.name, COUNT(s.id) AS server_count
    FROM server_groups g
    LEFT JOIN tracked_servers s ON s.group_id = g.id
    GROUP BY g.id
    ORDER BY g.name COLLATE NOCASE ASC`);
}

async function getTrackedServer(serverId) {
  return get(`SELECT
      s.id, s.group_id, g.name AS group_name, s.name, s.base_url,
      s.bearer_token, s.username, s.password, s.is_enabled
    FROM tracked_servers s
    JOIN server_groups g ON g.id = s.group_id
    WHERE s.id = ?`, [Number(serverId)]);
}

async function createTrackedServer({ groupName, name, baseUrl, bearerToken, username, password, enabled = true }) {
  const group = await findOrCreateServerGroup(groupName);
  const now = Date.now();
  const result = await run(`INSERT INTO tracked_servers (
      group_id, name, base_url, bearer_token, username, password, is_enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    group.id, normaliseName(name), baseUrl, bearerToken, username, password,
    enabled ? 1 : 0, now, now
  ]);
  return getTrackedServer(result.lastID);
}

async function updateTrackedServer(serverId, { groupName, name, baseUrl, bearerToken, username, password, enabled }) {
  const existing = await getTrackedServer(serverId);
  if (!existing) return undefined;
  const group = groupName === undefined ? { id: existing.group_id } : await findOrCreateServerGroup(groupName);
  await run(`UPDATE tracked_servers SET
      group_id = ?, name = ?, base_url = ?, bearer_token = ?, username = ?, password = ?,
      is_enabled = ?, updated_at = ?
    WHERE id = ?`, [
    group.id,
    name === undefined ? existing.name : normaliseName(name),
    baseUrl === undefined ? existing.base_url : baseUrl,
    bearerToken === undefined ? existing.bearer_token : bearerToken,
    username === undefined ? existing.username : username,
    password === undefined ? existing.password : password,
    enabled === undefined ? existing.is_enabled : enabled ? 1 : 0,
    Date.now(),
    existing.id
  ]);
  return getTrackedServer(existing.id);
}

async function deleteTrackedServer(serverId) {
  const existing = await getTrackedServer(serverId);
  if (!existing) return false;
  await run('BEGIN IMMEDIATE');
  try {
    await run('DELETE FROM client_state WHERE server_id = ?', [existing.id]);
    await run('DELETE FROM tracked_servers WHERE id = ?', [existing.id]);
    await run('DELETE FROM server_groups WHERE id = ? AND NOT EXISTS (SELECT 1 FROM tracked_servers WHERE group_id = ?)', [
      existing.group_id, existing.group_id
    ]);
    await run('COMMIT');
  } catch (error) {
    await run('ROLLBACK').catch(() => {});
    throw error;
  }
  return true;
}

function getClientState(serverId, clientId) {
  return get(
    'SELECT * FROM client_state WHERE server_id = ? AND client_id = ?',
    [Number(serverId), String(clientId)]
  );
}

function upsertClientState(
  serverId,
  clientId,
  tgId,
  email,
  expiryTime,
  isEnabled,
  isExpiredNotified,
  lastExpiryReminderDay = null
) {
  return run(
    `INSERT INTO client_state (
      server_id, client_id, telegram_id, email, expiry_time, is_enabled,
      is_expired_notified, last_expiry_reminder_day
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(server_id, client_id) DO UPDATE SET
      telegram_id = excluded.telegram_id,
      email = excluded.email,
      expiry_time = excluded.expiry_time,
      is_enabled = excluded.is_enabled,
      is_expired_notified = excluded.is_expired_notified,
      last_expiry_reminder_day = excluded.last_expiry_reminder_day`,
    [
      Number(serverId),
      String(clientId),
      String(tgId ?? ''),
      email || '',
      Number(expiryTime) || 0,
      isEnabled ? 1 : 0,
      isExpiredNotified ? 1 : 0,
      lastExpiryReminderDay || null
    ]
  );
}

/** Attach preserved single-panel state to the one-time imported default server. */
function claimLegacyClientStates(serverId) {
  return run('UPDATE client_state SET server_id = ? WHERE server_id = 0', [Number(serverId)]);
}

/** Return every observed, server-scoped client for the administrator dashboard. */
function listClientStates() {
  return all(`SELECT
      c.server_id, c.client_id, c.telegram_id, c.email, c.expiry_time,
      c.is_enabled, c.is_expired_notified, c.last_expiry_reminder_day,
      s.name AS server_name, g.name AS group_name
    FROM client_state c
    JOIN tracked_servers s ON s.id = c.server_id
    JOIN server_groups g ON g.id = s.group_id
    ORDER BY
      CASE WHEN c.expiry_time > 0 THEN c.expiry_time ELSE 9223372036854775807 END ASC,
      g.name COLLATE NOCASE ASC, s.name COLLATE NOCASE ASC, c.email COLLATE NOCASE ASC`);
}

/** Safe subscription details for a notification bot's own /start response. */
function listClientStatesForTelegram(telegramId) {
  return all(`SELECT
      c.email, c.expiry_time, c.is_enabled, s.name AS server_name, g.name AS group_name
    FROM client_state c
    JOIN tracked_servers s ON s.id = c.server_id
    JOIN server_groups g ON g.id = s.group_id
    WHERE c.telegram_id = ?
    ORDER BY
      CASE WHEN c.expiry_time > 0 THEN c.expiry_time ELSE 9223372036854775807 END ASC,
      g.name COLLATE NOCASE ASC, s.name COLLATE NOCASE ASC, c.email COLLATE NOCASE ASC`, [String(telegramId)]);
}

/** Summarise current, server-scoped client state without exposing panel credentials or sessions. */
function getClientSummary(now = Date.now()) {
  return get(`SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN c.is_enabled = 1 THEN 1 ELSE 0 END), 0) AS enabled,
      COALESCE(SUM(CASE WHEN c.is_enabled = 0 THEN 1 ELSE 0 END), 0) AS disabled,
      COALESCE(SUM(CASE WHEN c.expiry_time > 0 AND c.expiry_time <= ? THEN 1 ELSE 0 END), 0) AS expired,
      COALESCE(SUM(CASE WHEN c.expiry_time > ? THEN 1 ELSE 0 END), 0) AS expiring
    FROM client_state c
    JOIN tracked_servers s ON s.id = c.server_id`, [now, now]).then((row) => Object.fromEntries(
    Object.entries(row || {}).map(([key, value]) => [key, Number(value) || 0])
  ));
}

/** Close cleanly on process shutdown. */
function closeDatabase() {
  return new Promise((resolve, reject) => {
    db.close((error) => (error ? reject(error) : resolve()));
  });
}

module.exports = {
  claimLegacyClientStates,
  closeDatabase,
  createTrackedServer,
  deleteTrackedServer,
  getClientState,
  getClientSummary,
  getTrackedServer,
  initializeDatabase,
  listClientStates,
  listClientStatesForTelegram,
  listServerGroups,
  listServerSummaries,
  listTrackedServers,
  updateTrackedServer,
  upsertClientState
};
