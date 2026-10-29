const elements = {
  logout: document.querySelector('#logout'),
  form: document.querySelector('#announcement-form'),
  server: document.querySelector('#announcement-server'),
  message: document.querySelector('#announcement-message'),
  send: document.querySelector('#send-announcement'),
  result: document.querySelector('#announcement-result')
};

let csrfToken = '';
let servers = [];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function showMessage(message = '', kind = '') {
  elements.result.textContent = message;
  elements.result.className = `announcement-message ${kind}`;
}

function selectedServer() {
  return servers.find((server) => String(server.id) === elements.server.value);
}

function updateSendButton() {
  elements.send.disabled = !selectedServer() || !elements.message.value.trim();
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
    throw new Error('The server returned an invalid response.');
  }
  if (response.status === 401) {
    window.location.replace('/login');
    throw new Error('Your session has expired.');
  }
  if (!response.ok || payload.success !== true) throw new Error(payload.message || 'Server request failed.');
  return payload;
}

async function loadServers() {
  try {
    const payload = await requestJson('/api/servers');
    servers = payload.data.servers.filter((server) => server.enabled);
    elements.server.innerHTML = [
      `<option value="">${servers.length ? 'Select an enabled server' : 'No enabled servers'}</option>`,
      ...servers.map((server) => `<option value="${server.id}">${escapeHtml([server.groupName, server.name].filter(Boolean).join(' / '))}</option>`)
    ].join('');
    if (!servers.length) showMessage('Add and enable a server before sending customer announcements.');
  } catch (error) {
    showMessage(error.message || 'Could not load enabled servers.', 'error');
  }
  updateSendButton();
}

async function sendAnnouncement(event) {
  event.preventDefault();
  if (!elements.form.reportValidity()) return;
  const server = selectedServer();
  const message = elements.message.value;
  if (!server || !message.trim()) return;
  const serverLabel = [server.groupName, server.name].filter(Boolean).join(' / ');
  if (!window.confirm(`Send this announcement to all linked Telegram customers on ${serverLabel}?`)) return;

  elements.send.disabled = true;
  elements.send.textContent = 'Sending...';
  showMessage('Sending the announcement...');
  try {
    const payload = await requestJson(`/api/servers/${encodeURIComponent(server.id)}/notifications/announcement`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: JSON.stringify({ message })
    });
    elements.message.value = '';
    showMessage(payload.message, 'success');
  } catch (error) {
    showMessage(error.message || 'The server announcement could not be sent.', 'error');
  } finally {
    elements.send.textContent = 'Send to all customers';
    updateSendButton();
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

async function initialiseAnnouncements() {
  try {
    const payload = await requestJson('/api/auth/session');
    csrfToken = payload.data.csrfToken;
    await loadServers();
  } catch {
    // requestJson redirects to the sign-in screen if the session is absent.
  }
}

elements.server.addEventListener('change', updateSendButton);
elements.message.addEventListener('input', updateSendButton);
elements.form.addEventListener('submit', sendAnnouncement);
elements.logout.addEventListener('click', signOut);

initialiseAnnouncements();
