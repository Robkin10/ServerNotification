const elements = {
  logout: document.querySelector('#logout'),
  serverForm: document.querySelector('#server-form'),
  serverFormTitle: document.querySelector('#server-form-title'),
  serverFormMessage: document.querySelector('#server-form-message'),
  editingServerId: document.querySelector('#editing-server-id'),
  serverGroup: document.querySelector('#server-group'),
  serverGroupOptions: document.querySelector('#server-group-options'),
  serverName: document.querySelector('#server-name'),
  serverBaseUrl: document.querySelector('#server-base-url'),
  serverBearerToken: document.querySelector('#server-bearer-token'),
  serverUsername: document.querySelector('#server-username'),
  serverPassword: document.querySelector('#server-password'),
  serverEnabled: document.querySelector('#server-enabled'),
  saveServer: document.querySelector('#save-server'),
  cancelServerEdit: document.querySelector('#cancel-server-edit'),
  serverRows: document.querySelector('#server-rows')
};

let servers = [];
let csrfToken = '';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function showFormMessage(message = '', kind = '') {
  elements.serverFormMessage.textContent = message;
  elements.serverFormMessage.className = `form-message ${kind}`;
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

function renderServers(groups) {
  elements.serverGroupOptions.innerHTML = groups.map((group) => `<option value="${escapeHtml(group.name)}"></option>`).join('');
  if (!servers.length) {
    elements.serverRows.innerHTML = '<tr><td colspan="6" class="empty">No servers configured. Add server details to begin tracking.</td></tr>';
    return;
  }
  elements.serverRows.innerHTML = servers.map((server) => `<tr>
    <td>${escapeHtml(server.groupName)}</td>
    <td>${escapeHtml(server.name)}</td>
    <td class="url-cell">${escapeHtml(server.baseUrl)}</td>
    <td class="muted">${escapeHtml(server.username)}</td>
    <td><span class="badge ${server.enabled ? 'enabled' : 'disabled'}">${server.enabled ? 'Enabled' : 'Paused'}</span></td>
    <td class="server-actions"><button class="table-button" data-action="edit" data-server-id="${server.id}" type="button">Edit</button><button class="table-button danger" data-action="delete" data-server-id="${server.id}" type="button">Delete</button></td>
  </tr>`).join('');
}

async function loadServers() {
  try {
    const payload = await requestJson('/api/servers');
    servers = payload.data.servers;
    renderServers(payload.data.groups);
  } catch (error) {
    elements.serverRows.innerHTML = `<tr><td colspan="6" class="empty">${escapeHtml(error.message || 'Could not load configured servers.')}</td></tr>`;
  }
}

function resetServerForm() {
  elements.serverForm.reset();
  elements.serverEnabled.checked = true;
  elements.editingServerId.value = '';
  elements.serverFormTitle.textContent = 'Add Server details';
  elements.saveServer.textContent = 'Save server';
  elements.cancelServerEdit.hidden = true;
  elements.serverBearerToken.required = true;
  elements.serverPassword.required = true;
  elements.serverBearerToken.placeholder = '';
  elements.serverPassword.placeholder = '';
  showFormMessage();
}

function beginServerEdit(server) {
  elements.editingServerId.value = String(server.id);
  elements.serverGroup.value = server.groupName;
  elements.serverName.value = server.name;
  elements.serverBaseUrl.value = server.baseUrl;
  elements.serverUsername.value = server.username;
  elements.serverBearerToken.value = '';
  elements.serverPassword.value = '';
  elements.serverEnabled.checked = server.enabled;
  elements.serverFormTitle.textContent = 'Edit Server details';
  elements.saveServer.textContent = 'Save changes';
  elements.cancelServerEdit.hidden = false;
  elements.serverBearerToken.required = false;
  elements.serverPassword.required = false;
  elements.serverBearerToken.placeholder = 'Leave blank to keep the stored token';
  elements.serverPassword.placeholder = 'Leave blank to keep the stored password';
  showFormMessage('Leave the bearer token and password blank to keep their stored values.');
  elements.serverName.focus();
}

async function saveServer(event) {
  event.preventDefault();
  if (!elements.serverForm.reportValidity()) return;
  const serverId = elements.editingServerId.value;
  const payload = {
    groupName: elements.serverGroup.value,
    name: elements.serverName.value,
    baseUrl: elements.serverBaseUrl.value,
    bearerToken: elements.serverBearerToken.value,
    username: elements.serverUsername.value,
    password: elements.serverPassword.value,
    enabled: elements.serverEnabled.checked
  };
  elements.saveServer.disabled = true;
  showFormMessage(serverId ? 'Saving changes…' : 'Saving server…');
  try {
    const response = await requestJson(serverId ? `/api/servers/${encodeURIComponent(serverId)}` : '/api/servers', {
      method: serverId ? 'PUT' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: JSON.stringify(payload)
    });
    resetServerForm();
    const initialSync = response.data?.initialSync;
    if (!serverId && initialSync?.success) {
      showFormMessage(`Server saved. ${initialSync.clientsTracked} VLESS client key(s) synchronized.`, 'success');
    } else if (!serverId && initialSync && !initialSync.skipped) {
      showFormMessage('Server saved, but the initial client sync failed. The scheduled audit will retry it.', 'error');
    } else if (!serverId && initialSync?.skipped) {
      showFormMessage('Server saved. Its initial client sync is queued behind the current audit.', 'success');
    } else {
      showFormMessage('Server details saved.', 'success');
    }
    await loadServers();
  } catch (error) {
    showFormMessage(error.message || 'Server details could not be saved.', 'error');
  } finally {
    elements.saveServer.disabled = false;
  }
}

async function deleteServer(server) {
  if (!window.confirm(`Delete ${server.name} and its stored client state? This cannot be undone.`)) return;
  showFormMessage(`Deleting ${server.name}…`);
  try {
    await requestJson(`/api/servers/${encodeURIComponent(server.id)}`, {
      method: 'DELETE',
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    });
    if (elements.editingServerId.value === String(server.id)) resetServerForm();
    showFormMessage('Server deleted.', 'success');
    await loadServers();
  } catch (error) {
    showFormMessage(error.message || 'Server could not be deleted.', 'error');
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

async function initialiseServerManagement() {
  try {
    const payload = await requestJson('/api/auth/session');
    csrfToken = payload.data.csrfToken;
    await loadServers();
  } catch {
    // requestJson redirects to the sign-in screen if the session is absent.
  }
}

elements.serverForm.addEventListener('submit', saveServer);
elements.cancelServerEdit.addEventListener('click', resetServerForm);
elements.logout.addEventListener('click', signOut);
elements.serverRows.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const server = servers.find((item) => item.id === Number(button.dataset.serverId));
  if (!server) return;
  if (button.dataset.action === 'edit') beginServerEdit(server);
  if (button.dataset.action === 'delete') deleteServer(server);
});

initialiseServerManagement();
