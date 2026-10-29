const { isValidTelegramId } = require('./notificationPolicy');

/** Sends a plain-text announcement once to every Telegram customer tracked on one server. */
class AnnouncementService {
  constructor({ listRecipientsForServer, notify }) {
    this.listRecipientsForServer = listRecipientsForServer;
    this.notify = notify;
  }

  async send(server, { message } = {}) {
    const serverId = Number(server?.id);
    if (!Number.isSafeInteger(serverId) || serverId < 1) {
      throw new Error('A saved server is required for customer announcements.');
    }
    if (typeof message !== 'string' || !message.trim()) throw new Error('An announcement message is required.');

    const recipients = await this.listRecipientsForServer(serverId);
    if (!Array.isArray(recipients)) {
      throw new Error('Stored customer data did not contain a recipient list.');
    }
    const result = {
      success: true,
      skipped: false,
      clientsChecked: 0,
      recipients: 0,
      sent: 0,
      failed: 0,
      skippedClients: 0,
      missingTelegram: 0
    };
    const notifiedTelegramIds = new Set();

    for (const recipient of recipients) {
      result.clientsChecked += 1;
      if (!isValidTelegramId(recipient?.telegram_id)) {
        result.missingTelegram += 1;
        result.skippedClients += 1;
        continue;
      }
      const telegramId = String(recipient.telegram_id).trim();
      if (notifiedTelegramIds.has(telegramId)) {
        result.skippedClients += 1;
        continue;
      }
      notifiedTelegramIds.add(telegramId);
      result.recipients += 1;
      try {
        if (await this.notify(telegramId, message)) result.sent += 1;
        else result.failed += 1;
      } catch {
        result.failed += 1;
      }
    }
    result.success = result.failed === 0;
    return result;
  }
}

module.exports = { AnnouncementService };
