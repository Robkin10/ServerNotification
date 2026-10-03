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
    getClientLinks: async (email) => [`vless://${email}`],
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
    clientDetailsFailed: 0,
    clientLinksFetched: 2,
    clientLinksFailed: 0,
    clientLinksUpdated: 2,
    clientsRemoved: 0
  });
  assert.equal(notifications.length, 1);
  assert.match(notifications[0][1], /VLESS key expired/);
  assert.deepEqual(saved, [
    ['expired@example.test', '101', 'expired@example.test', now - 1, true, 1, null, '["vless://expired@example.test"]'],
    ['unbound@example.test', '', 'unbound@example.test', now + 1, true, 0, null, '["vless://unbound@example.test"]']
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
    getClientLinks: async () => ['vless://client@example.test'],
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
    'client@example.test', 'new-chat-id', 'client@example.test', now + (10 * 24 * 60 * 60 * 1000), true, 0, null, '["vless://client@example.test"]'
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
    getClientLinks: async () => ['vless://changed@example.test'],
    getState: async () => ({ expiry_time: now - 60_000, is_enabled: 1, is_expired_notified: 1 }),
    saveState: async (...args) => saved.push(args),
    notify: async () => true
  });

  const result = await engine.runAudit();
  assert.equal(result.notificationsSent, 1);
  assert.deepEqual(saved, [['changed@example.test', '202', 'changed@example.test', now + 60_000, false, 0, null, '["vless://changed@example.test"]']]);
});

test('refreshes the stored VLESS link when 3X-UI returns an updated link', async () => {
  const saved = [];
  const now = 1_750_000_000_000;
  const engine = new TrackerEngine({
    now: () => now,
    logger: { info() {}, error() {} },
    listClients: async () => [{ email: 'client@example.test' }],
    getClientDetails: async () => ({
      email: 'client@example.test', tgId: '101', expiryTime: now + (10 * 24 * 60 * 60 * 1000), enable: true
    }),
    getClientLinks: async () => ['vless://new-link'],
    getState: async () => ({
      telegram_id: '101', expiry_time: now + (10 * 24 * 60 * 60 * 1000), is_enabled: 1,
      is_expired_notified: 0, last_expiry_reminder_day: null, vless_links: '["vless://old-link"]'
    }),
    saveState: async (...args) => saved.push(args),
    notify: async () => true
  });

  const result = await engine.runAudit();
  assert.equal(result.clientLinksFetched, 1);
  assert.equal(result.clientLinksUpdated, 1);
  assert.equal(result.notificationsSent, 0);
  assert.equal(saved[0][7], '["vless://new-link"]');
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
    getClientLinks: async () => ['vless://reminder@example.test'],
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
      }),
      getClientLinks: async () => [`vless://${baseUrl}`]
    }),
    getState: async () => undefined,
    saveState: async (...args) => saved.push(args),
    deleteClientStatesAbsentFromPanel: async () => 0,
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

test('removes tracked VLESS keys that are absent from a complete panel client list', async () => {
  const removed = [];
  const engine = new TrackerEngine({
    logger: { info() {}, error() {} },
    listServers: async () => [
      { id: 31, group_name: 'Production', name: 'Panel', base_url: 'https://panel.example.test', bearer_token: 'a', username: 'u', password: 'p' }
    ],
    createPanelService: async () => ({
      listClients: async () => [{ email: 'active@example.test' }],
      getClientDetails: async () => ({ email: 'active@example.test', enable: true }),
      getClientLinks: async () => []
    }),
    getState: async () => undefined,
    saveState: async () => {},
    deleteClientStatesAbsentFromPanel: async (serverId, clientIds) => {
      removed.push({ serverId, clientIds });
      return 2;
    }
  });

  const result = await engine.runAudit();

  assert.equal(result.success, true);
  assert.equal(result.clientsRemoved, 2);
  assert.deepEqual(removed, [{ serverId: 31, clientIds: ['active@example.test'] }]);
});

test('removes all tracked VLESS keys for a server when its valid panel list is empty', async () => {
  const removed = [];
  const engine = new TrackerEngine({
    logger: { info() {}, error() {} },
    listServers: async () => [
      { id: 34, group_name: 'Production', name: 'Empty panel', base_url: 'https://panel.example.test', bearer_token: 'a', username: 'u', password: 'p' }
    ],
    createPanelService: async () => ({
      listClients: async () => []
    }),
    deleteClientStatesAbsentFromPanel: async (serverId, clientIds) => {
      removed.push({ serverId, clientIds });
      return 3;
    }
  });

  const result = await engine.runAudit();

  assert.equal(result.success, true);
  assert.equal(result.clientsRemoved, 3);
  assert.deepEqual(removed, [{ serverId: 34, clientIds: [] }]);
});

test('preserves tracked VLESS keys when the panel client list cannot be trusted', async () => {
  const removed = [];
  const engine = new TrackerEngine({
    logger: { info() {}, error() {} },
    listServers: async () => [
      { id: 32, group_name: 'Production', name: 'Panel', base_url: 'https://panel.example.test', bearer_token: 'a', username: 'u', password: 'p' }
    ],
    createPanelService: async () => ({
      listClients: async () => [{ email: 'active@example.test' }, { id: 'missing-email' }],
      getClientDetails: async () => ({ email: 'active@example.test', enable: true }),
      getClientLinks: async () => []
    }),
    getState: async () => undefined,
    saveState: async () => {},
    deleteClientStatesAbsentFromPanel: async (...args) => removed.push(args)
  });

  const result = await engine.runAudit();

  assert.equal(result.success, true);
  assert.equal(result.invalidClients, 1);
  assert.equal(result.clientsRemoved, 0);
  assert.deepEqual(removed, []);
});

test('preserves tracked VLESS keys when a panel client-list request fails', async () => {
  const removed = [];
  const engine = new TrackerEngine({
    logger: { info() {}, error() {} },
    listServers: async () => [
      { id: 33, group_name: 'Production', name: 'Panel', base_url: 'https://panel.example.test', bearer_token: 'a', username: 'u', password: 'p' }
    ],
    createPanelService: async () => ({
      listClients: async () => { throw new Error('Panel unavailable'); }
    }),
    deleteClientStatesAbsentFromPanel: async (...args) => removed.push(args)
  });

  const result = await engine.runAudit();

  assert.equal(result.success, false);
  assert.equal(result.serversFailed, 1);
  assert.equal(result.clientsRemoved, 0);
  assert.deepEqual(removed, []);
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

test('delivers cached selected-server links only to their saved Telegram recipients', async () => {
  const notifications = [];
  const selectedServer = {
    id: 6, group_name: 'Migration', name: 'New node', base_url: 'https://panel.example.test',
    bearer_token: 'token', username: 'user', password: 'password'
  };
  const engine = new TrackerEngine({
    logger: { info() {}, error() {} },
    listClientStatesForServer: async () => [
      { email: 'alice@example.test', telegram_id: '101', vless_links: '["vless://alice-uuid@vless.example.test:443?security=reality#alice"]' },
      { email: 'unbound@example.test', telegram_id: '', vless_links: '["vless://unbound"]' },
      { email: 'missing-link@example.test', telegram_id: '303', vless_links: '[]' }
    ],
    notify: async (...args) => {
      notifications.push(args);
      return true;
    }
  });

  assert.deepEqual(await engine.sendClientLinks(selectedServer), {
    success: true,
    skipped: false,
    clientsChecked: 3,
    linksPrepared: 1,
    sent: 1,
    failed: 0,
    skippedClients: 2,
    missingTelegram: 1,
    validationFailures: 0,
    detailFailures: 0,
    linkFailures: 1
  });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0][0], '101');
  assert.match(notifications[0][1], /Email: `alice@example\.test`/);
  assert.match(notifications[0][1], /vless:\/\/alice-uuid@vless\.example\.test:443/);
  assert.match(notifications[0][1], /Server: `Migration \/ New node`/);
});

test('delivers only the requested cached client link without contacting the panel', async () => {
  const notifications = [];
  const selectedServer = {
    id: 7, group_name: 'Migration', name: 'New node', base_url: 'https://panel.example.test',
    bearer_token: 'token', username: 'user', password: 'password'
  };
  const engine = new TrackerEngine({
    logger: { info() {}, error() {} },
    listClientStatesForServer: async () => [
      { email: 'alice@example.test', telegram_id: '101', vless_links: '["vless://alice@example.test"]' },
      { email: 'bob@example.test', telegram_id: '202', vless_links: '["vless://bob@example.test"]' }
    ],
    notify: async (...args) => {
      notifications.push(args);
      return true;
    }
  });

  assert.deepEqual(await engine.sendClientLinks(selectedServer, { clientEmail: ' ALICE@example.test ' }), {
    success: true,
    skipped: false,
    clientsChecked: 1,
    linksPrepared: 1,
    sent: 1,
    failed: 0,
    skippedClients: 0,
    missingTelegram: 0,
    validationFailures: 0,
    detailFailures: 0,
    linkFailures: 0
  });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0][0], '101');
  assert.match(notifications[0][1], /vless:\/\/alice@example\.test/);
});
