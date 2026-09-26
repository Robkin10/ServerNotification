const assert = require('node:assert/strict');
const test = require('node:test');
const { TrackerEngine } = require('../trackerEngine');
const { formatNotificationDate } = require('../dateFormat');

test('formats Telegram expiry timestamps in Asia/Yangon', () => {
  assert.equal(
    formatNotificationDate(Date.UTC(2026, 8, 29, 17, 30, 0)),
    '30 Sep 2026, 12:00 AM'
  );
});

test('tracks Telegram-bound clients and sends a single expiry notification', async () => {
  const saved = [];
  const notifications = [];
  const now = 1_750_000_000_000;
  const engine = new TrackerEngine({
    now: () => now,
    logger: { info() {}, error() {} },
    listClients: async () => [
      { id: 'expired-id', email: 'expired@example.test' },
      { id: 'unbound-id', email: 'unbound@example.test' },
      null
    ],
    getClientDetails: async (email) => email === 'expired@example.test'
      ? { id: 'expired-id', tgId: '101', email, expiryTime: now - 1, enable: true }
      : { id: 'unbound-id', email, expiryTime: now + 1, enable: true },
    getState: async () => undefined,
    saveState: async (...args) => saved.push(args),
    notify: async (...args) => {
      notifications.push(args);
      return true;
    }
  });

  const result = await engine.runAudit();

  assert.deepEqual(result, {
    success: true,
    skipped: false,
    startedAt: new Date(now).toISOString(),
    completedAt: new Date(now).toISOString(),
    clientsFetched: 3,
    clientsTracked: 2,
    notificationsSent: 1,
    invalidClients: 1,
    clientDetailsFetched: 2,
    clientDetailsFailed: 0
  });
  assert.equal(notifications.length, 1);
  assert.match(notifications[0][1], /VLESS key expired/);
  assert.deepEqual(saved, [
    ['expired@example.test', '101', 'expired@example.test', now - 1, true, 1, null],
    ['unbound@example.test', '', 'unbound@example.test', now + 1, true, 0, null]
  ]);
});

test('synchronizes an updated 3X-UI Telegram ID without waiting for a manual save', async () => {
  const saved = [];
  const now = 1_750_000_000_000;
  const engine = new TrackerEngine({
    now: () => now,
    logger: { info() {}, error() {} },
    listClients: async () => [{ email: 'client@example.test' }],
    getClientDetails: async () => ({
      email: 'client@example.test', tgId: 'new-chat-id', expiryTime: now + (10 * 24 * 60 * 60 * 1000), enable: true
    }),
    getState: async () => ({
      telegram_id: 'old-chat-id', expiry_time: now + (10 * 24 * 60 * 60 * 1000),
      is_enabled: 1, is_expired_notified: 0, last_expiry_reminder_day: null
    }),
    saveState: async (...args) => saved.push(args),
    notify: async () => {
      throw new Error('Changing a recipient alone must not send a configuration-change message.');
    }
  });

  const result = await engine.runAudit();

  assert.equal(result.clientsTracked, 1);
  assert.equal(result.notificationsSent, 0);
  assert.deepEqual(saved, [[
    'client@example.test', 'new-chat-id', 'client@example.test', now + (10 * 24 * 60 * 60 * 1000), true, 0, null
  ]]);
});

test('notifies on a state change and resets an old expiry notification after extension', async () => {
  const saved = [];
  const now = 1_750_000_000_000;
  const engine = new TrackerEngine({
    now: () => now,
    logger: { info() {}, error() {} },
    listClients: async () => [{ id: 'changed-id', email: 'changed@example.test' }],
    getClientDetails: async (email) => ({ id: 'changed-id', tgId: '202', email, expiryTime: now + 60_000, enable: false }),
    getState: async () => ({ expiry_time: now - 60_000, is_enabled: 1, is_expired_notified: 1 }),
    saveState: async (...args) => saved.push(args),
    notify: async () => true
  });

  const result = await engine.runAudit();
  assert.equal(result.notificationsSent, 1);
  assert.deepEqual(saved, [['changed@example.test', '202', 'changed@example.test', now + 60_000, false, 0, null]]);
});

test('sends one final-three-days reminder per Asia/Yangon calendar day with remaining days', async () => {
  const now = Date.UTC(2026, 0, 10, 12, 0, 0);
  const expiryTime = now + (3 * 24 * 60 * 60 * 1000);
  const messages = [];
  let state = {
    telegram_id: '303',
    expiry_time: expiryTime,
    is_enabled: 1,
    is_expired_notified: 0,
    last_expiry_reminder_day: null
  };
  const engine = new TrackerEngine({
    now: () => now,
    logger: { info() {}, error() {} },
    listClients: async () => [{ email: 'reminder@example.test' }],
    getClientDetails: async () => ({
      email: 'reminder@example.test', tgId: '303', expiryTime, enable: true
    }),
    getState: async () => state,
    saveState: async (id, tgId, email, expiry, enabled, expiredNotified, reminderDay) => {
      state = {
        telegram_id: tgId,
        expiry_time: expiry,
        is_enabled: enabled ? 1 : 0,
        is_expired_notified: expiredNotified,
        last_expiry_reminder_day: reminderDay
      };
    },
    notify: async (tgId, message) => {
      messages.push({ tgId, message });
      return true;
    }
  });

  assert.equal((await engine.runAudit()).notificationsSent, 1);
  assert.equal((await engine.runAudit()).notificationsSent, 0);
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /Remaining: \*3 days\*/);
  assert.equal(state.last_expiry_reminder_day, '2026-01-10');
});

test('sends a manual test message once per distinct detail-response tgId', async () => {
  const notified = [];
  const engine = new TrackerEngine({
    logger: { info() {}, error() {} },
    listClients: async () => [
      { email: 'first@example.test' },
      { email: 'same@example.test' },
      { email: 'failed@example.test' }
    ],
    getClientDetails: async (email) => ({
      email,
      tgId: email === 'failed@example.test' ? '202' : '101'
    }),
    notify: async (tgId, message) => {
      notified.push({ tgId, message });
      return tgId === '101';
    }
  });

  assert.deepEqual(await engine.sendTestNotifications(), {
    success: true,
    skipped: false,
    recipients: 2,
    sent: 1,
    failed: 1,
    detailFailures: 0
  });
  assert.equal(notified.length, 2);
  assert.match(notified[0].message, /test notification/);
});

test('isolates state and notifications for clients on different configured servers', async () => {
  const now = 1_750_000_000_000;
  const saved = [];
  const notifications = [];
  const serverClients = new Map([
    ['https://one.example.test', { email: 'shared@example.test', tgId: '501' }],
    ['https://two.example.test', { email: 'shared@example.test', tgId: '501' }]
  ]);
  const engine = new TrackerEngine({
    now: () => now,
    logger: { info() {}, error() {} },
    listServers: async () => [
      { id: 11, group_name: 'Alpha', name: 'One', base_url: 'https://one.example.test', bearer_token: 'a', username: 'u', password: 'p' },
      { id: 22, group_name: 'Beta', name: 'Two', base_url: 'https://two.example.test', bearer_token: 'b', username: 'u', password: 'p' }
    ],
    createPanelService: async ({ baseUrl }) => ({
      listClients: async () => [{ email: serverClients.get(baseUrl).email }],
      getClientDetails: async () => ({
        ...serverClients.get(baseUrl), expiryTime: now - 1, enable: true
      })
    }),
    getState: async () => undefined,
    saveState: async (...args) => saved.push(args),
    notify: async (...args) => {
      notifications.push(args);
      return true;
    }
  });

  const result = await engine.runAudit();

  assert.equal(result.success, true);
  assert.deepEqual(
    { configured: result.serversConfigured, audited: result.serversAudited, failed: result.serversFailed },
    { configured: 2, audited: 2, failed: 0 }
  );
  assert.equal(result.clientsTracked, 2);
  assert.equal(result.notificationsSent, 2);
  assert.deepEqual(saved.map((entry) => entry.slice(0, 2)), [
    [11, 'shared@example.test'],
    [22, 'shared@example.test']
  ]);
  assert.match(notifications[0][1], /Server: `Alpha \/ One`/);
  assert.match(notifications[1][1], /Server: `Beta \/ Two`/);
});

test('sends test notifications separately for the same chat on each server', async () => {
  const notified = [];
  const engine = new TrackerEngine({
    logger: { info() {}, error() {} },
    listServers: async () => [
      { id: 1, group_name: 'East', name: 'Panel', base_url: 'https://east.example.test', bearer_token: 'a', username: 'u', password: 'p' },
      { id: 2, group_name: 'West', name: 'Panel', base_url: 'https://west.example.test', bearer_token: 'b', username: 'u', password: 'p' }
    ],
    createPanelService: async () => ({
      listClients: async () => [{ email: 'client@example.test' }],
      getClientDetails: async () => ({ email: 'client@example.test', tgId: '777' })
    }),
    notify: async (...args) => {
      notified.push(args);
      return true;
    }
  });

  assert.deepEqual(await engine.sendTestNotifications(), {
    success: true,
    skipped: false,
    recipients: 2,
    sent: 2,
    failed: 0,
    detailFailures: 0,
    serversFailed: 0
  });
  assert.equal(notified.length, 2);
  assert.match(notified[0][1], /Server: `East \/ Panel`/);
  assert.match(notified[1][1], /Server: `West \/ Panel`/);
});

test('delivers selected-server links only after validating the email and Telegram ID', async () => {
  const notifications = [];
  const selectedServer = {
    id: 6, group_name: 'Migration', name: 'New node', base_url: 'https://panel.example.test',
    bearer_token: 'token', username: 'user', password: 'password'
  };
  const engine = new TrackerEngine({
    logger: { info() {}, error() {} },
    createPanelService: async () => ({
      listClients: async () => [
        { email: 'alice@example.test' },
        { email: 'unbound@example.test' },
        { email: 'mismatch@example.test' },
        { email: 'missing-link@example.test' },
        { email: 'detail-error@example.test' }
      ],
      getClientDetails: async (email) => {
        if (email === 'detail-error@example.test') throw new Error('not found');
        if (email === 'unbound@example.test') return { email, tgId: '' };
        if (email === 'mismatch@example.test') return { email: 'someone-else@example.test', tgId: '202' };
        if (email === 'missing-link@example.test') return { email, tgId: '303' };
        return { email, tgId: '101' };
      },
      getClientLinks: async (email) => {
        if (email === 'missing-link@example.test') return [];
        return ['vless://alice-uuid@vless.example.test:443?security=reality#alice'];
      }
    }),
    notify: async (...args) => {
      notifications.push(args);
      return true;
    }
  });

  assert.deepEqual(await engine.sendClientLinks(selectedServer), {
    success: true,
    skipped: false,
    clientsChecked: 5,
    linksPrepared: 1,
    sent: 1,
    failed: 0,
    skippedClients: 4,
    missingTelegram: 1,
    validationFailures: 1,
    detailFailures: 1,
    linkFailures: 1
  });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0][0], '101');
  assert.match(notifications[0][1], /Email: `alice@example\.test`/);
  assert.match(notifications[0][1], /vless:\/\/alice-uuid@vless\.example\.test:443/);
  assert.match(notifications[0][1], /Server: `Migration \/ New node`/);
});
