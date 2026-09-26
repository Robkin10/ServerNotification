const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { once } = require('node:events');
const { createApp, dashboardCredentials } = require('../server');

function request(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const client = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers
    }, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { responseBody += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: responseBody, headers: response.headers }));
    });
    client.on('error', reject);
    client.end(body);
  });
}

async function signIn(port, username, password) {
  const response = await request(port, '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  assert.equal(response.status, 200);
  const payload = JSON.parse(response.body);
  const cookie = response.headers['set-cookie'][0].split(';')[0];
  return {
    cookie,
    csrfToken: payload.data.csrfToken,
    headers: { Cookie: cookie }
  };
}

test('shows a login screen and protects dashboard data with a session', async () => {
  const environment = { DASHBOARD_USER: 'dashboard-user', DASHBOARD_PASS: 'dashboard-pass' };
  const engine = {
    getStatus: () => ({
      running: false,
      lastStartedAt: null,
      lastCompletedAt: null,
      lastSuccessAt: '2025-01-01T00:00:00.000Z',
      lastError: null,
      lastResult: { clientsTracked: 1, notificationsSent: 0 }
    }),
    sendTestNotifications: async () => ({
      success: true,
      skipped: false,
      recipients: 1,
      sent: 1,
      failed: 0,
      detailFailures: 0
    })
  };
  const database = {
    getClientSummary: async () => ({ total: 1, enabled: 1, disabled: 0, expired: 0, expiring: 1 }),
    listClientStates: async () => [{
      vless_id: 'client-id', telegram_id: '42', email: 'user@example.test', expiry_time: 1_900_000_000_000,
      is_enabled: 1, is_expired_notified: 0
    }]
  };
  const server = http.createServer(createApp({ engine, database, environment }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const port = server.address().port;
    const unauthenticatedPage = await request(port, '/');
    assert.equal(unauthenticatedPage.status, 302);
    assert.equal(unauthenticatedPage.headers.location, '/login');

    const unauthenticatedApi = await request(port, '/api/dashboard');
    assert.equal(unauthenticatedApi.status, 401);
    assert.equal(JSON.parse(unauthenticatedApi.body).success, false);

    const loginPage = await request(port, '/login');
    assert.equal(loginPage.status, 200);
    assert.match(loginPage.body, /Sign in to the tracker/);

    const rejectedLogin = await request(port, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'dashboard-user', password: 'wrong' })
    });
    assert.equal(rejectedLogin.status, 401);

    const session = await signIn(port, 'dashboard-user', 'dashboard-pass');
    assert.match(session.cookie, /^tracker_session=/);
    const dashboard = await request(port, '/api/dashboard', { headers: session.headers });
    assert.equal(dashboard.status, 200);
    const payload = JSON.parse(dashboard.body);
    assert.equal(payload.success, true);
    assert.equal(payload.data.summary.total, 1);
    assert.deepEqual(payload.data.clients[0], {
      id: 'client-id', email: 'user@example.test', telegramId: '42', expiryTime: 1_900_000_000_000,
      enabled: true, expired: false, expiryNotified: false
    });

    const serverManagement = await request(port, '/servers', { headers: session.headers });
    assert.equal(serverManagement.status, 200);
    assert.match(serverManagement.body, /Add Server details/);
    assert.doesNotMatch(serverManagement.body, /Tracked VLESS keys/);

    const missingCsrf = await request(port, '/api/notifications/test', {
      method: 'POST', headers: { ...session.headers, 'X-Requested-With': 'XMLHttpRequest' }
    });
    assert.equal(missingCsrf.status, 403);

    const notification = await request(port, '/api/notifications/test', {
      method: 'POST',
      headers: { ...session.headers, 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': session.csrfToken }
    });
    assert.equal(notification.status, 200);
    assert.deepEqual(JSON.parse(notification.body).result, {
      recipients: 1,
      sent: 1,
      failed: 0,
      detailFailures: 0
    });

    const logout = await request(port, '/api/auth/logout', {
      method: 'POST',
      headers: { ...session.headers, 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': session.csrfToken }
    });
    assert.equal(logout.status, 200);
    assert.equal((await request(port, '/api/dashboard', { headers: session.headers })).status, 401);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('uses documented local dashboard defaults when credentials are omitted', () => {
  assert.deepEqual(dashboardCredentials({}), { username: 'admin', password: 'admin123' });
});

test('stores server details through the protected session API without returning credentials', async () => {
  const created = [];
  const auditCalls = [];
  const database = {
    createTrackedServer: async (input) => {
      created.push(input);
      return {
        id: 7, group_id: 3, group_name: input.groupName, name: input.name,
        base_url: input.baseUrl, bearer_token: input.bearerToken, username: input.username,
        password: input.password, is_enabled: input.enabled ? 1 : 0, created_at: 10, updated_at: 10
      };
    },
    deleteTrackedServer: async () => false,
    getClientSummary: async () => ({ total: 0, enabled: 0, disabled: 0, expired: 0, expiring: 0 }),
    listClientStates: async () => [],
    listServerGroups: async () => [{ id: 3, name: 'Production', server_count: 1 }],
    listServerSummaries: async () => [{
      id: 7, group_id: 3, group_name: 'Production', name: 'Node one', base_url: 'https://panel.example.test',
      username: 'panel-user', is_enabled: 1, created_at: 10, updated_at: 10
    }],
    updateTrackedServer: async () => undefined
  };
  const engine = {
    getStatus: () => ({}),
    runAudit: async (options) => {
      auditCalls.push(options);
      return { success: true, skipped: false, clientsFetched: 4, clientsTracked: 4, clientDetailsFailed: 0 };
    },
    sendTestNotifications: async () => ({})
  };
  const server = http.createServer(createApp({ engine, database, environment: { DASHBOARD_USER: 'user', DASHBOARD_PASS: 'pass' } }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const port = server.address().port;
    const session = await signIn(port, 'user', 'pass');
    const body = JSON.stringify({
      groupName: 'Production',
      name: 'Node one',
      baseUrl: 'https://panel.example.test/',
      bearerToken: 'private-bearer-token',
      username: 'panel-user',
      password: 'private-password',
      enabled: true
    });
    const forbidden = await request(port, '/api/servers', {
      method: 'POST', headers: { ...session.headers, 'Content-Type': 'application/json' }, body
    });
    assert.equal(forbidden.status, 403);

    const createdResponse = await request(port, '/api/servers', {
      method: 'POST',
      headers: {
        ...session.headers,
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRF-Token': session.csrfToken
      },
      body
    });
    assert.equal(createdResponse.status, 201);
    assert.deepEqual(created, [{
      groupName: 'Production', name: 'Node one', baseUrl: 'https://panel.example.test',
      bearerToken: 'private-bearer-token', username: 'panel-user', password: 'private-password', enabled: true
    }]);
    assert.deepEqual(auditCalls, [{ serverIds: [7] }]);
    assert.doesNotMatch(createdResponse.body, /private-bearer-token|private-password/);
    assert.deepEqual(JSON.parse(createdResponse.body).data.initialSync, {
      success: true, skipped: false, clientsFetched: 4, clientsTracked: 4, clientDetailsFailed: 0
    });

    const listed = await request(port, '/api/servers', { headers: session.headers });
    assert.equal(listed.status, 200);
    assert.doesNotMatch(listed.body, /bearer|password/i);
    assert.deepEqual(JSON.parse(listed.body).data.servers[0], {
      id: 7, groupId: 3, groupName: 'Production', name: 'Node one', baseUrl: 'https://panel.example.test',
      username: 'panel-user', enabled: true, createdAt: 10, updatedAt: 10, credentialsConfigured: true
    });
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('sends client links only for the selected server through a CSRF-protected action', async () => {
  const selectedServers = [];
  const configuredServer = {
    id: 8, group_name: 'Migration', name: 'Replacement node', base_url: 'https://panel.example.test',
    bearer_token: 'not-returned', username: 'panel-user', password: 'not-returned', is_enabled: 1
  };
  const engine = {
    getStatus: () => ({}),
    sendClientLinks: async (server) => {
      selectedServers.push(server);
      return {
        success: true, skipped: false, clientsChecked: 3, linksPrepared: 2, sent: 2, failed: 0,
        skippedClients: 1, missingTelegram: 1, validationFailures: 0, detailFailures: 0, linkFailures: 0
      };
    }
  };
  const database = { getTrackedServer: async (id) => Number(id) === 8 ? configuredServer : undefined };
  const server = http.createServer(createApp({ engine, database, environment: { DASHBOARD_USER: 'user', DASHBOARD_PASS: 'pass' } }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const port = server.address().port;
    const session = await signIn(port, 'user', 'pass');
    const forbidden = await request(port, '/api/servers/8/notifications/links', {
      method: 'POST', headers: { ...session.headers, 'X-Requested-With': 'XMLHttpRequest' }
    });
    assert.equal(forbidden.status, 403);

    const delivered = await request(port, '/api/servers/8/notifications/links', {
      method: 'POST', headers: {
        ...session.headers, 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': session.csrfToken
      }
    });
    assert.equal(delivered.status, 200);
    assert.deepEqual(selectedServers, [configuredServer]);
    assert.deepEqual(JSON.parse(delivered.body), {
      success: true,
      message: 'Link delivery complete: 2 delivered, 0 failed, 1 skipped.',
      result: {
        clientsChecked: 3, linksPrepared: 2, sent: 2, failed: 0, skippedClients: 1,
        missingTelegram: 1, validationFailures: 0, detailFailures: 0, linkFailures: 0
      }
    });
    assert.doesNotMatch(delivered.body, /not-returned|vless:\/\//);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
