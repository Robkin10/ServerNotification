const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { once } = require('node:events');
const {
  ThreeXuiApiError,
  createPanelUrls,
  createThreeXuiService
} = require('../panelApi');

function json(response, status, payload, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    ...headers
  });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

async function withMockPanel(handler, callback) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();

  try {
    return await callback(`http://127.0.0.1:${address.port}/tracker-prefix/`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

function serviceFor(baseUrl) {
  return createThreeXuiService({
    baseUrl,
    bearerToken: 'mock-bearer-token',
    username: 'mock-user',
    password: 'mock-password',
    timeoutMs: 2_000
  });
}

test('uses CSRF response cookies, form login, bearer auth, and session cookies for inbounds', async () => {
  const observed = { csrf: 0, login: 0, inbounds: 0 };

  await withMockPanel(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer mock-bearer-token');

    if (request.method === 'GET' && request.url === '/tracker-prefix/csrf-token') {
      observed.csrf += 1;
      json(response, 200, { success: true, obj: 'csrf-value' }, {
        'Set-Cookie': 'csrf_seed=from-csrf; Path=/; HttpOnly'
      });
      return;
    }

    if (request.method === 'POST' && request.url === '/tracker-prefix/login') {
      observed.login += 1;
      assert.match(request.headers.cookie || '', /csrf_seed=from-csrf/);
      assert.equal(request.headers['x-csrf-token'], 'csrf-value');
      assert.match(request.headers['content-type'], /^application\/x-www-form-urlencoded/);
      const form = new URLSearchParams(await readBody(request));
      assert.equal(form.get('username'), 'mock-user');
      assert.equal(form.get('password'), 'mock-password');
      assert.equal(form.get('twoFactorCode'), '654321');
      json(response, 200, { success: true, obj: null }, {
        'Set-Cookie': 'session_id=authenticated; Path=/; HttpOnly'
      });
      return;
    }

    if (request.method === 'GET' && request.url === '/tracker-prefix/panel/api/inbounds/list') {
      observed.inbounds += 1;
      const cookie = request.headers.cookie || '';
      assert.match(cookie, /csrf_seed=from-csrf/);
      assert.match(cookie, /session_id=authenticated/);
      json(response, 200, { success: true, obj: [{ id: 7, remark: 'mock inbound' }] });
      return;
    }

    json(response, 404, { success: false });
  }, async (baseUrl) => {
    const service = await serviceFor(baseUrl);
    const inbounds = await service.listInbounds({ twoFactorCode: '654321' });
    assert.deepEqual(inbounds, [{ id: 7, remark: 'mock inbound' }]);
  });

  assert.deepEqual(observed, { csrf: 1, login: 1, inbounds: 1 });
});

test('stops after a rejected login and does not request inbounds', async () => {
  const observed = { csrf: 0, login: 0, inbounds: 0 };

  await withMockPanel((request, response) => {
    if (request.method === 'GET' && request.url === '/tracker-prefix/csrf-token') {
      observed.csrf += 1;
      json(response, 200, { success: true, obj: 'csrf-value' }, {
        'Set-Cookie': 'csrf_seed=from-csrf; Path=/'
      });
      return;
    }
    if (request.method === 'POST' && request.url === '/tracker-prefix/login') {
      observed.login += 1;
      json(response, 200, { success: false, msg: 'rejected' });
      return;
    }
    observed.inbounds += 1;
    json(response, 500, { success: false });
  }, async (baseUrl) => {
    const service = await serviceFor(baseUrl);
    await assert.rejects(
      service.listInbounds(),
      (error) => error instanceof ThreeXuiApiError && error.code === 'LOGIN_REJECTED'
    );
  });

  assert.deepEqual(observed, { csrf: 1, login: 1, inbounds: 0 });
});

test('reauthenticates once after an expired session and retries only the safe inbound GET', async () => {
  const observed = { csrf: 0, login: 0, inbounds: 0 };

  await withMockPanel((request, response) => {
    if (request.method === 'GET' && request.url === '/tracker-prefix/csrf-token') {
      observed.csrf += 1;
      json(response, 200, { success: true, obj: `csrf-${observed.csrf}` }, {
        'Set-Cookie': `csrf_seed=${observed.csrf}; Path=/; HttpOnly`
      });
      return;
    }
    if (request.method === 'POST' && request.url === '/tracker-prefix/login') {
      observed.login += 1;
      assert.equal(request.headers['x-csrf-token'], `csrf-${observed.login}`);
      json(response, 200, { success: true, obj: null }, {
        'Set-Cookie': `session_id=session-${observed.login}; Path=/; HttpOnly`
      });
      return;
    }
    if (request.method === 'GET' && request.url === '/tracker-prefix/panel/api/inbounds/list') {
      observed.inbounds += 1;
      if (observed.inbounds === 1) {
        json(response, 403, { success: false, msg: 'session expired' });
      } else {
        assert.match(request.headers.cookie || '', /session_id=session-2/);
        json(response, 200, { success: true, obj: [{ id: 8 }] });
      }
      return;
    }
    json(response, 404, { success: false });
  }, async (baseUrl) => {
    const service = await serviceFor(baseUrl);
    assert.deepEqual(await service.listInbounds(), [{ id: 8 }]);
  });

  assert.deepEqual(observed, { csrf: 2, login: 2, inbounds: 2 });
});

test('shares one login between concurrent inbound requests', async () => {
  const observed = { csrf: 0, login: 0, inbounds: 0 };

  await withMockPanel((request, response) => {
    if (request.method === 'GET' && request.url === '/tracker-prefix/csrf-token') {
      observed.csrf += 1;
      json(response, 200, { success: true, obj: 'csrf-value' }, {
        'Set-Cookie': 'csrf_seed=from-csrf; Path=/'
      });
      return;
    }
    if (request.method === 'POST' && request.url === '/tracker-prefix/login') {
      observed.login += 1;
      json(response, 200, { success: true, obj: null }, {
        'Set-Cookie': 'session_id=authenticated; Path=/'
      });
      return;
    }
    if (request.method === 'GET' && request.url === '/tracker-prefix/panel/api/inbounds/list') {
      observed.inbounds += 1;
      json(response, 200, { success: true, obj: [{ id: observed.inbounds }] });
      return;
    }
    json(response, 404, { success: false });
  }, async (baseUrl) => {
    const service = await serviceFor(baseUrl);
    const [first, second] = await Promise.all([service.listInbounds(), service.listInbounds()]);
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
  });

  assert.deepEqual(observed, { csrf: 1, login: 1, inbounds: 2 });
});

test('preserves a custom base path and avoids a duplicate panel path', () => {
  assert.deepEqual(createPanelUrls('https://panel.example.test/custom/panel/'), {
    baseUrl: 'https://panel.example.test/custom/panel',
    csrfToken: 'https://panel.example.test/custom/panel/csrf-token',
    login: 'https://panel.example.test/custom/panel/login',
    inbounds: 'https://panel.example.test/custom/panel/api/inbounds/list',
    clients: 'https://panel.example.test/custom/panel/api/clients/list',
    clientDetails: 'https://panel.example.test/custom/panel/api/clients/get',
    clientLinks: 'https://panel.example.test/custom/panel/api/clients/links'
  });
});

test('lists clients through the supplied full-client endpoint', async () => {
  await withMockPanel((request, response) => {
    if (request.method === 'GET' && request.url === '/tracker-prefix/csrf-token') {
      json(response, 200, { success: true, obj: 'csrf-value' }, {
        'Set-Cookie': 'csrf_seed=from-csrf; Path=/'
      });
      return;
    }
    if (request.method === 'POST' && request.url === '/tracker-prefix/login') {
      json(response, 200, { success: true, obj: null }, {
        'Set-Cookie': 'session_id=authenticated; Path=/'
      });
      return;
    }
    if (request.method === 'GET' && request.url === '/tracker-prefix/panel/api/clients/list') {
      assert.match(request.headers.cookie || '', /session_id=authenticated/);
      json(response, 200, {
        success: true,
        obj: [{ id: 'client-id', email: 'client@example.test', tgId: '900', enable: true }]
      });
      return;
    }
    json(response, 404, { success: false });
  }, async (baseUrl) => {
    const service = await serviceFor(baseUrl);
    assert.deepEqual(await service.listClients(), [
      { id: 'client-id', email: 'client@example.test', tgId: '900', enable: true }
    ]);
  });
});

test('retrieves authoritative client details with an encoded email path', async () => {
  await withMockPanel((request, response) => {
    if (request.method === 'GET' && request.url === '/tracker-prefix/csrf-token') {
      json(response, 200, { success: true, obj: 'csrf-value' }, {
        'Set-Cookie': 'csrf_seed=from-csrf; Path=/'
      });
      return;
    }
    if (request.method === 'POST' && request.url === '/tracker-prefix/login') {
      json(response, 200, { success: true, obj: null }, {
        'Set-Cookie': 'session_id=authenticated; Path=/'
      });
      return;
    }
    if (request.method === 'GET' && request.url === '/tracker-prefix/panel/api/clients/get/client%40example.test') {
      assert.match(request.headers.cookie || '', /session_id=authenticated/);
      json(response, 200, {
        success: true,
        obj: {
          client: {
            email: 'client@example.test',
            tgId: '900',
            expiryTime: 1_900_000_000_000,
            enable: true,
            privateKey: 'must-not-be-returned'
          }
        }
      });
      return;
    }
    json(response, 404, { success: false });
  }, async (baseUrl) => {
    const service = await serviceFor(baseUrl);
    assert.deepEqual(await service.getClientDetails('client@example.test'), {
      email: 'client@example.test', tgId: '900', expiryTime: 1_900_000_000_000, enable: true
    });
  });
});

test('retrieves the panel-generated VLESS links with an encoded email path', async () => {
  await withMockPanel((request, response) => {
    if (request.method === 'GET' && request.url === '/tracker-prefix/csrf-token') {
      json(response, 200, { success: true, obj: 'csrf-value' }, {
        'Set-Cookie': 'csrf_seed=from-csrf; Path=/'
      });
      return;
    }
    if (request.method === 'POST' && request.url === '/tracker-prefix/login') {
      json(response, 200, { success: true, obj: null }, {
        'Set-Cookie': 'session_id=authenticated; Path=/'
      });
      return;
    }
    if (request.method === 'GET' && request.url === '/tracker-prefix/panel/api/clients/links/client%40example.test') {
      assert.match(request.headers.cookie || '', /session_id=authenticated/);
      json(response, 200, {
        success: true,
        obj: [
          'vless://uuid@node.example.test:443?security=reality#client',
          'trojan://not-sent@example.test:443#client'
        ]
      });
      return;
    }
    json(response, 404, { success: false });
  }, async (baseUrl) => {
    const service = await serviceFor(baseUrl);
    assert.deepEqual(await service.getClientLinks('client@example.test'), [
      'vless://uuid@node.example.test:443?security=reality#client'
    ]);
  });
});
