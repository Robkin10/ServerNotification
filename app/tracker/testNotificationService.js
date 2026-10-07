const { isValidTelegramId, serverLine } = require('./notificationPolicy');
const { panelErrorMessage } = require('./auditService');

/** Finds panel-bound recipients and sends one deliberately labeled test message. */
class TestNotificationService {
  constructor({ multiServerMode, listServers, sourceFactory, notify, logger = console }) {
    this.multiServerMode = multiServerMode;
    this.listServers = listServers;
    this.sourceFactory = sourceFactory;
    this.notify = notify;
    this.logger = logger;
  }

  async send() {
    const servers = this.multiServerMode
      ? await this.listServers()
      : [{ id: 'legacy', name: 'Default server' }];
    if (!Array.isArray(servers)) throw new Error('Server configuration did not contain an array.');

    const recipients = new Map();
    let detailFailures = 0;
    let serversFailed = 0;
    for (const server of servers) {
      try {
        const source = await this.sourceFactory.create(server);
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
        const label = [server.group_name, server.name].filter(Boolean).join(' / ') || 'a configured server';
        this.logger.error(`Test notification lookup failed for ${label}: ${panelErrorMessage(error)}`);
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
  }
}

module.exports = { TestNotificationService };
