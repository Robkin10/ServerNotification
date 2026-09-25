const elements = {
  status: document.querySelector('#connection-status'),
  logout: document.querySelector('#logout'),
  refresh: document.querySelector('#refresh'),
  sendTestNotification: document.querySelector('#send-test-notification'),
  error: document.querySelector('#error-message'),
  lastSuccess: document.querySelector('#last-success'),
  auditResult: document.querySelector('#audit-result'),
  total: document.querySelector('#total-count'),
  enabled: document.querySelector('#enabled-count'),
  expired: document.querySelector('#expired-count'),
  disabled: document.querySelector('#disabled-count'),
  filter: document.querySelector('#client-filter'),
  rows: document.querySelector('#client-rows')
};

let clients = [];
let csrfToken = '';

function formatDate(value) {
  if (!value) return 'Not yet completed';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function setStatus(kind, text) {
  elements.status.className = `status ${kind}`;
  elements.status.textContent = text;
}

function clientServerLabel(client) {
  return [client.serverGroup, client.serverName].filter(Boolean).join(' / ') || 'Unknown server';
}

function renderRows() {
  const search = elements.filter.value.trim().toLowerCase();
  const visibleClients = clients.filter((client) => `${client.email} ${client.telegramId || ''} ${clientServerLabel(client)}`.toLowerCase().includes(search));
  if (!visibleClients.length) {
    elements.rows.innerHTML = '<tr><td colspan="6" class="empty">No matching tracked clients.</td></tr>';
    return;
  }

  elements.rows.innerHTML = visibleClients.map((client) => {
    const state = client.expired ? ['expired', 'Expired'] : client.enabled ? ['enabled', 'Enabled'] : ['disabled', 'Disabled'];
    const expiry = client.expiryTime ? formatDate(client.expiryTime) : 'No expiration';
    const notification = client.expired ? (client.expiryNotified ? ['enabled', 'Sent'] : ['pending', 'Pending']) : '&mdash;';
    const notificationHtml = Array.isArray(notification) ? `<span class="badge ${notification[0]}">${notification[1]}</span>` : notification;
    return `<tr><td class="server-cell">${escapeHtml(clientServerLabel(client))}</td><td>${escapeHtml(client.email)}</td><td class="muted">${escapeHtml(client.telegramId || 'Not bound')}</td><td><span class="badge ${state[0]}">${state[1]}</span></td><td>${escapeHtml(expiry)}</td><td>${notificationHtml}</td></tr>`;
  }).join('');
}

function render(data) {
  const { summary, tracker } = data;
  clients = data.clients;
  elements.total.textContent = summary.total;
  elements.enabled.textContent = summary.enabled;
  elements.expired.textContent = summary.expired;
  elements.disabled.textContent = summary.disabled;
  elements.lastSuccess.textContent = formatDate(tracker.lastSuccessAt);
  const auditedServers = tracker.lastResult?.serversAudited;
  const serverDescription = auditedServers === undefined ? '' : ` across ${auditedServers} server${auditedServers === 1 ? '' : 's'}`;
  elements.auditResult.textContent = tracker.running
    ? 'Audit currently running'
    : tracker.lastResult
      ? `${tracker.lastResult.clientsTracked} clients checked${serverDescription} · ${tracker.lastResult.notificationsSent} notifications sent`
      : 'Waiting for first audit';
  elements.error.hidden = !tracker.lastError;
  elements.error.classList.remove('success-message');
  elements.error.textContent = tracker.lastError || '';
  setStatus(tracker.lastError ? 'error' : 'ok', tracker.lastError ? 'Audit error' : tracker.running ? 'Auditing' : 'Connected');
  renderRows();
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      ...(options.headers || {})
    }
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('The dashboard returned an invalid response.');
  }
  if (response.status === 401) {
    window.location.replace('/login');
    throw new Error('Your session has expired.');
  }
  if (!response.ok || payload.success !== true) throw new Error(payload.message || 'Dashboard request failed.');
  return payload;
}

async function loadDashboard() {
  elements.refresh.disabled = true;
  setStatus('loading', 'Refreshing');
  try {
    const payload = await requestJson('/api/dashboard');
    render(payload.data);
  } catch {
    setStatus('error', 'Unavailable');
    elements.error.hidden = false;
    elements.error.textContent = 'Could not load dashboard data. Refresh to try again.';
  } finally {
    elements.refresh.disabled = false;
  }
}

async function sendTestNotification() {
  if (!window.confirm('Send one test notification to each Telegram recipient on every enabled server?')) return;
  elements.sendTestNotification.disabled = true;
  elements.sendTestNotification.textContent = 'Sending…';
  try {
    const payload = await requestJson('/api/notifications/test', {
      method: 'POST',
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    });
    elements.error.hidden = false;
    elements.error.classList.add('success-message');
    elements.error.textContent = payload.message;
  } catch (error) {
    elements.error.hidden = false;
    elements.error.classList.remove('success-message');
    elements.error.textContent = error.message || 'Test notifications could not be sent.';
  } finally {
    elements.sendTestNotification.disabled = false;
    elements.sendTestNotification.textContent = 'Send test notification';
  }
}

async function signOut() {
  elements.logout.disabled = true;
  try {
    await requestJson('/api/auth/logout', {
      method: 'POST',
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    });
  } finally {
    window.location.replace('/login');
  }
}

async function initialiseDashboard() {
  try {
    const payload = await requestJson('/api/auth/session');
    csrfToken = payload.data.csrfToken;
    await loadDashboard();
    window.setInterval(loadDashboard, 30_000);
  } catch {
    // requestJson redirects to the sign-in screen if the session is absent.
  }
}

elements.refresh.addEventListener('click', loadDashboard);
elements.sendTestNotification.addEventListener('click', sendTestNotification);
elements.logout.addEventListener('click', signOut);
elements.filter.addEventListener('input', renderRows);
initialiseDashboard();
