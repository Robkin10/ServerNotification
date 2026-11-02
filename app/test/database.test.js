const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();

function run(database, sql, parameters = []) {
  return new Promise((resolve, reject) => {
    database.run(sql, parameters, (error) => (error ? reject(error) : resolve()));
  });
}

function all(database, sql, parameters = []) {
  return new Promise((resolve, reject) => {
    database.all(sql, parameters, (error, rows) => (error ? reject(error) : resolve(rows || [])));
  });
}

function close(database) {
  return new Promise((resolve, reject) => database.close((error) => (error ? reject(error) : resolve())));
}

test('removes legacy VLESS link cache data while preserving tracked client state', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-tracker-db-'));
  const databasePath = path.join(temporaryDirectory, 'tracker.db');
  const legacyDatabase = new sqlite3.Database(databasePath);

  try {
    await run(legacyDatabase, `CREATE TABLE client_state (
      server_id INTEGER NOT NULL,
      client_id TEXT NOT NULL,
      telegram_id TEXT,
      email TEXT,
      expiry_time INTEGER,
      is_enabled INTEGER,
      is_expired_notified INTEGER DEFAULT 0,
      last_expiry_reminder_day TEXT,
      last_notification_type TEXT,
      vless_links TEXT,
      PRIMARY KEY (server_id, client_id)
    )`);
    await run(legacyDatabase, 'CREATE INDEX client_state_server_idx ON client_state(server_id)');
    await run(legacyDatabase, `INSERT INTO client_state (
      server_id, client_id, telegram_id, email, expiry_time, is_enabled,
      is_expired_notified, last_expiry_reminder_day, last_notification_type, vless_links
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      9, 'client@example.test', '101', 'client@example.test', 1_750_000_000_000, 1,
      0, '2026-11-02', 'expires_in_3_days', '["vless://legacy-secret"]'
    ]);
    await close(legacyDatabase);

    process.env.TRACKER_DATABASE_PATH = databasePath;
    const database = require('../database');
    await database.initializeDatabase();

    const state = await database.getClientState(9, 'client@example.test');
    assert.deepEqual(state, {
      server_id: 9,
      client_id: 'client@example.test',
      telegram_id: '101',
      email: 'client@example.test',
      expiry_time: 1_750_000_000_000,
      is_enabled: 1,
      is_expired_notified: 0,
      last_expiry_reminder_day: '2026-11-02',
      last_notification_type: 'expires_in_3_days'
    });
    await database.closeDatabase();

    const migratedDatabase = new sqlite3.Database(databasePath);
    const columns = await all(migratedDatabase, 'PRAGMA table_info(client_state)');
    const indexes = await all(migratedDatabase, 'PRAGMA index_list(client_state)');
    await close(migratedDatabase);
    assert.equal(columns.some((column) => column.name === 'vless_links'), false);
    assert.equal(indexes.some((index) => index.name === 'client_state_server_idx'), true);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
