const {
  getClientState,
  listTrackedServers,
  upsertClientState
} = require('./database');
const {
  createThreeXuiService,
  fetchClientDetails,
  fetchClients,
  ThreeXuiApiError
} = require('./panelApi');
const { sendDirectMessage } = require('./telegram');
const { formatNotificationDate, notificationDay } = require('./dateFormat');

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

function isValidTelegramId(tgId) {
  if (tgId === undefined || tgId === null) return false;
  const value = String(tgId).trim();
  return value !== '' && value !== '0';
}

function normaliseExpiryTime(expiryTime) {
  const value = Number(expiryTime);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function normaliseEnabled(enable) {
  if (typeof enable === 'string') {
    return enable.trim() === '1' || enable.trim().toLowerCase() === 'true';
  }
  return enable === true || enable === 1;
}

function formatExpiry(expiryTime) {
  return formatNotificationDate(expiryTime);
}

function reminderDay(now) {
  return notificationDay(now);
}

function remainingDays(expiryTime, now) {
  return Math.ceil((expiryTime - now) / DAY_IN_MILLISECONDS);
}

function escapeMarkdown(value) {
  return String(value ?? '').replace(/([_`*\[\]])/g, '\\$1');
}

function serverLabel(server) {
  if (!server) return '';
  return [server.group_name, server.name].filter(Boolean).join(' / ');
}

function serverLine(server) {
  const label = serverLabel(server);
  return label ? `Server: \`${escapeMarkdown(label)}\`` : null;
}

function expiredMessage(email, expiryTime, server) {
  return [
    '*VLESS key expired*',
    '',
    serverLine(server),
    `Email: \`${escapeMarkdown(email)}\``,
    `Expired: \`${formatExpiry(expiryTime)}\``
  ].filter(Boolean).join('\n');
}

function updatedMessage(email, expiryTime, isEnabled, server) {
  return [
    '*VLESS key configuration updated*',
    '',
    serverLine(server),
    `Email: \`${escapeMarkdown(email)}\``,
    `Status: *${isEnabled ? 'Enabled' : 'Disabled'}*`,
    `Expiry: \`${formatExpiry(expiryTime)}\``
  ].filter(Boolean).join('\n');
}

function expiringSoonMessage(email, expiryTime, days, server) {
  const dayLabel = days === 1 ? 'day' : 'days';
  return [
    '*VLESS key expires soon*',
    '',
    serverLine(server),
    `Email: \`${escapeMarkdown(email)}\``,
    `Expires: \`${formatExpiry(expiryTime)}\``,
    `Remaining: *${days} ${dayLabel}*`
  ].filter(Boolean).join('\n');
}

function panelErrorMessage(error) {
  if (error instanceof ThreeXuiApiError) return error.toPublicMessage();
  return 'The scheduled panel audit could not be completed.';
}

function createAuditResult(now, multiServerMode) {
  const result = {
    success: false,
    skipped: false,
    startedAt: new Date(now).toISOString(),
    completedAt: null,
    clientsFetched: 0,
    clientsTracked: 0,
    notificationsSent: 0,
    invalidClients: 0,
    clientDetailsFetched: 0,
    clientDetailsFailed: 0
  };
  if (multiServerMode) {
    result.serversConfigured = 0;
    result.serversAudited = 0;
    result.serversFailed = 0;
  }
  return result;
}

/**
 * Audits every enabled database server independently. A panel account only
 * ever reads and writes state under its own server id, so an email or tgId on
 * two panels cannot suppress or redirect the other panel's notification.
 */
class TrackerEngine {
  constructor(options = {}) {
    const legacySourcesProvided = typeof options.listClients === 'function' || typeof options.getClientDetails === 'function';
    this.multiServerMode = !legacySourcesProvided;
    this.listClients = options.listClients || fetchClients;
    this.getClientDetails = options.getClientDetails || fetchClientDetails;
    this.listServers = options.listServers || listTrackedServers;
    this.createPanelService = options.createPanelService || createThreeXuiService;
    this.getState = options.getState || getClientState;
    this.saveState = options.saveState || upsertClientState;
    this.notify = options.notify || sendDirectMessage;
    this.logger = options.logger || console;
    this.now = options.now || (() => Date.now());
    this.twoFactorCode = options.twoFactorCode || (() => process.env.THREEXUI_TWO_FACTOR_CODE);
    this.auditInProgress = false;
    this.followUpAuditServerIds = new Set();
    this.testNotificationInProgress = false;
    this.status = {
      running: false,
      lastStartedAt: null,
      lastCompletedAt: null,
      lastSuccessAt: null,
      lastError: null,
      lastResult: null
    };
  }

  getStatus() {
    return {
      ...this.status,
      lastResult: this.status.lastResult ? { ...this.status.lastResult } : null
    };
  }

  async getPanelSource(server) {
    if (!this.multiServerMode) {
      return {
        clients: await this.listClients({ twoFactorCode: this.twoFactorCode() }),
        getClientDetails: (email) => this.getClientDetails(email, { twoFactorCode: this.twoFactorCode() })
      };
    }

    const panel = await this.createPanelService({
      baseUrl: server.base_url,
      bearerToken: server.bearer_token,
      username: server.username,
      password: server.password
    });
    return {
      clients: await panel.listClients({ twoFactorCode: this.twoFactorCode() }),
      getClientDetails: (email) => panel.getClientDetails(email, { twoFactorCode: this.twoFactorCode() })
    };
  }

  async getPreviousState(server, clientId) {
    return this.multiServerMode ? this.getState(server.id, clientId) : this.getState(clientId);
  }

  async saveClientState(server, clientId, tgId, email, expiryTime, isEnabled, isExpiredNotified, lastExpiryReminderDay) {
    if (this.multiServerMode) {
      return this.saveState(
        server.id, clientId, tgId, email, expiryTime, isEnabled,
        isExpiredNotified, lastExpiryReminderDay
      );
    }
    return this.saveState(
      clientId, tgId, email, expiryTime, isEnabled,
      isExpiredNotified, lastExpiryReminderDay
    );
  }

  async auditClient(server, client, result) {
    const clientId = typeof client.email === 'string' ? client.email.trim() : '';
    if (!clientId) return;

    const email = client.email || '';
    const tgId = isValidTelegramId(client.tgId) ? String(client.tgId).trim() : '';
    const hasTelegramRecipient = Boolean(tgId);
    const expiryTime = normaliseExpiryTime(client.expiryTime);
    const isEnabled = normaliseEnabled(client.enable);
    const previous = await this.getPreviousState(server, clientId);
    const previousTelegramId = String(previous?.telegram_id ?? '').trim();
    const telegramChanged = Boolean(
      previous && previous.telegram_id !== undefined && previousTelegramId !== tgId
    );
    const expiryChanged = Boolean(previous && Number(previous.expiry_time) !== expiryTime);
    const hasChanged = Boolean(
      previous &&
      (expiryChanged || Number(previous.is_enabled) !== Number(isEnabled))
    );
    const now = this.now();
    const isExpired = expiryTime > 0 && now >= expiryTime;
    let isExpiredNotified = previous ? Number(previous.is_expired_notified) : 0;
    let lastExpiryReminderDay = previous?.last_expiry_reminder_day || null;
    const notificationServer = this.multiServerMode ? server : undefined;

    if (!hasTelegramRecipient) {
      // Keep the panel's unbound state too. If the customer later adds a tgId,
      // the next audit will use that new recipient rather than stale data.
      isExpiredNotified = 0;
      lastExpiryReminderDay = null;
    } else {
      if (telegramChanged) lastExpiryReminderDay = null;
      if (isExpired && (!isExpiredNotified || telegramChanged)) {
        if (await this.notify(tgId, expiredMessage(email, expiryTime, notificationServer))) {
          isExpiredNotified = 1;
          result.notificationsSent += 1;
        }
      } else if (hasChanged) {
        if (await this.notify(tgId, updatedMessage(email, expiryTime, isEnabled, notificationServer))) {
          result.notificationsSent += 1;
        }
        if (expiryTime > this.now()) isExpiredNotified = 0;
        if (expiryChanged) lastExpiryReminderDay = null;
      } else if (expiryTime > now) {
        const days = remainingDays(expiryTime, now);
        const today = reminderDay(now);
        if (days >= 1 && days <= 3 && lastExpiryReminderDay !== today) {
          if (await this.notify(tgId, expiringSoonMessage(email, expiryTime, days, notificationServer))) {
            result.notificationsSent += 1;
          }
          // Mark the attempted daily reminder even if Telegram is temporarily unavailable.
          // This prevents a frequent audit schedule from repeatedly messaging one user.
          lastExpiryReminderDay = today;
        } else if (days > 3) {
          lastExpiryReminderDay = null;
        }
      }
    }

    await this.saveClientState(
      server, clientId, tgId, email, expiryTime, isEnabled,
      isExpiredNotified, lastExpiryReminderDay
    );
    result.clientsTracked += 1;
  }

  async auditServer(server, result) {
    const source = await this.getPanelSource(server);
    if (!Array.isArray(source.clients)) {
      throw new Error('Panel client response did not contain an array.');
    }

    result.clientsFetched += source.clients.length;
    for (const clientSummary of source.clients) {
      if (!clientSummary || typeof clientSummary !== 'object' || typeof clientSummary.email !== 'string' || !clientSummary.email.trim()) {
        result.invalidClients += 1;
        continue;
      }

      try {
        const details = await source.getClientDetails(clientSummary.email);
        // The detail response is authoritative because list endpoints may omit tgId.
        const client = { ...clientSummary, ...details, email: details.email || clientSummary.email };
        result.clientDetailsFetched += 1;
        await this.auditClient(server, client, result);
      } catch {
        result.clientDetailsFailed += 1;
      }
    }
  }

  finishAudit(result, startedAt, errorMessage = null) {
    result.completedAt = new Date(this.now()).toISOString();
    this.status = {
      running: false,
      lastStartedAt: startedAt,
      lastCompletedAt: result.completedAt,
      lastSuccessAt: result.success ? result.completedAt : this.status.lastSuccessAt,
      lastError: errorMessage,
      lastResult: result
    };
    return result;
  }

  async runAudit({ serverIds } = {}) {
    if (this.auditInProgress) {
      if (this.multiServerMode && Array.isArray(serverIds)) {
        for (const serverId of serverIds) this.followUpAuditServerIds.add(Number(serverId));
      }
      return { ...this.status.lastResult, skipped: true };
    }

    this.auditInProgress = true;
    const startedAt = new Date(this.now()).toISOString();
    const result = createAuditResult(this.now(), this.multiServerMode);
    result.startedAt = startedAt;
    this.status = { ...this.status, running: true, lastStartedAt: startedAt, lastError: null };

    try {
      let servers = this.multiServerMode
        ? await this.listServers()
        : [{ id: 'legacy', name: 'Default server' }];
      if (!Array.isArray(servers)) throw new Error('Server configuration did not contain an array.');

      if (this.multiServerMode && Array.isArray(serverIds) && serverIds.length) {
        const requestedIds = new Set(serverIds.map((serverId) => Number(serverId)));
        servers = servers.filter((server) => requestedIds.has(Number(server.id)));
      }

      if (this.multiServerMode) {
        result.serversConfigured = servers.length;
        if (!servers.length) {
          this.finishAudit(result, startedAt, 'No enabled servers are configured.');
          this.logger.info('Audit skipped: no enabled servers are configured.');
          return result;
        }
      }

      const failures = [];
      for (const server of servers) {
        try {
          await this.auditServer(server, result);
          if (this.multiServerMode) result.serversAudited += 1;
        } catch (error) {
          if (!this.multiServerMode) throw error;
          result.serversFailed += 1;
          failures.push(`${serverLabel(server) || 'Configured server'}: ${panelErrorMessage(error)}`);
          this.logger.error(`Audit failed for ${serverLabel(server) || 'a configured server'}: ${panelErrorMessage(error)}`);
        }
      }

      result.success = failures.length === 0;
      const errorMessage = failures.length ? failures.join(' ') : null;
      this.finishAudit(result, startedAt, errorMessage);
      this.logger.info(`Audit complete: synchronized ${result.clientsTracked} VLESS client(s).`);
      return result;
    } catch (error) {
      const message = panelErrorMessage(error);
      this.finishAudit(result, startedAt, message);
      this.logger.error(`Audit failed: ${message}`);
      return result;
    } finally {
      this.auditInProgress = false;
      if (this.followUpAuditServerIds.size) {
        const queuedServerIds = [...this.followUpAuditServerIds];
        this.followUpAuditServerIds.clear();
        setImmediate(() => this.runAudit({ serverIds: queuedServerIds }));
      }
    }
  }

  /** Send one clearly labeled test message to each panel-bound recipient. */
  async sendTestNotifications() {
    if (this.testNotificationInProgress) {
      return { success: false, skipped: true, recipients: 0, sent: 0, failed: 0, detailFailures: 0 };
    }

    this.testNotificationInProgress = true;
    try {
      const servers = this.multiServerMode
        ? await this.listServers()
        : [{ id: 'legacy', name: 'Default server' }];
      if (!Array.isArray(servers)) throw new Error('Server configuration did not contain an array.');

      const recipients = new Map();
      let detailFailures = 0;
      let serversFailed = 0;
      for (const server of servers) {
        try {
          const source = await this.getPanelSource(server);
          if (!Array.isArray(source.clients)) throw new Error('Panel client response did not contain an array.');
          for (const clientSummary of source.clients) {
            if (!clientSummary || typeof clientSummary.email !== 'string' || !clientSummary.email.trim()) continue;
            try {
              const details = await source.getClientDetails(clientSummary.email);
              if (isValidTelegramId(details.tgId)) {
                const recipientId = String(details.tgId).trim();
                const key = this.multiServerMode ? `${server.id}:${recipientId}` : recipientId;
                recipients.set(key, { recipientId, server });
              }
            } catch {
              detailFailures += 1;
            }
          }
        } catch (error) {
          if (!this.multiServerMode) throw error;
          serversFailed += 1;
          this.logger.error(`Test notification lookup failed for ${serverLabel(server) || 'a configured server'}: ${panelErrorMessage(error)}`);
        }
      }

      let sent = 0;
      let failed = 0;
      for (const { recipientId, server } of recipients.values()) {
        const message = [
          '*3X-UI tracker test notification*',
          '',
          this.multiServerMode ? serverLine(server) : null,
          'This confirms that Telegram notifications are configured correctly.',
          'No action is required.'
        ].filter(Boolean).join('\n');
        if (await this.notify(recipientId, message)) sent += 1;
        else failed += 1;
      }

      const result = {
        success: serversFailed === 0,
        skipped: false,
        recipients: recipients.size,
        sent,
        failed,
        detailFailures
      };
      if (this.multiServerMode) result.serversFailed = serversFailed;
      this.logger.info(`Test notification run complete: ${sent}/${recipients.size} delivered.`);
      return result;
    } finally {
      this.testNotificationInProgress = false;
    }
  }
}

module.exports = {
  TrackerEngine,
  isValidTelegramId,
  normaliseEnabled,
  normaliseExpiryTime,
  remainingDays
};
