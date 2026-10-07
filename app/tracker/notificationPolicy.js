const { formatNotificationDate, notificationDay } = require('../dateFormat');

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
    `Expired: \`${formatNotificationDate(expiryTime)}\``
  ].filter(Boolean).join('\n');
}

function updatedMessage(email, expiryTime, isEnabled, server) {
  return [
    '*VLESS key configuration updated*',
    '',
    serverLine(server),
    `Email: \`${escapeMarkdown(email)}\``,
    `Status: *${isEnabled ? 'Enabled' : 'Disabled'}*`,
    `Expiry: \`${formatNotificationDate(expiryTime)}\``
  ].filter(Boolean).join('\n');
}

function expiringSoonMessage(email, expiryTime, days, server) {
  const dayLabel = days === 1 ? 'day' : 'days';
  return [
    '*VLESS key expires soon*',
    '',
    serverLine(server),
    `Email: \`${escapeMarkdown(email)}\``,
    `Expires: \`${formatNotificationDate(expiryTime)}\``,
    `Remaining: *${days} ${dayLabel}*`
  ].filter(Boolean).join('\n');
}

/** Applies notification rules and returns the persisted notification state. */
class NotificationPolicy {
  constructor({ now = () => Date.now(), notify, multiServerMode = false } = {}) {
    this.now = now;
    this.notify = notify;
    this.multiServerMode = multiServerMode;
  }

  async evaluate({ client, previous, server }) {
    const email = client.email || '';
    const tgId = isValidTelegramId(client.tgId) ? String(client.tgId).trim() : '';
    const hasTelegramRecipient = Boolean(tgId);
    const expiryTime = normaliseExpiryTime(client.expiryTime);
    const isEnabled = normaliseEnabled(client.enable);
    const previousTelegramId = String(previous?.telegram_id ?? '').trim();
    const telegramChanged = Boolean(
      previous && previous.telegram_id !== undefined && previousTelegramId !== tgId
    );
    const expiryChanged = Boolean(previous && Number(previous.expiry_time) !== expiryTime);
    const hasChanged = Boolean(
      previous && (expiryChanged || Number(previous.is_enabled) !== Number(isEnabled))
    );
    const now = this.now();
    const isExpired = expiryTime > 0 && now >= expiryTime;
    let isExpiredNotified = previous ? Number(previous.is_expired_notified) : 0;
    let lastExpiryReminderDay = previous?.last_expiry_reminder_day || null;
    let notificationsSent = 0;
    const notificationServer = this.multiServerMode ? server : undefined;

    if (!hasTelegramRecipient) {
      // A later panel binding should start with fresh notification state.
      isExpiredNotified = 0;
      lastExpiryReminderDay = null;
    } else {
      if (telegramChanged) lastExpiryReminderDay = null;
      if (isExpired && (!isExpiredNotified || telegramChanged)) {
        if (await this.notify(tgId, expiredMessage(email, expiryTime, notificationServer))) {
          isExpiredNotified = 1;
          notificationsSent += 1;
        }
      } else if (hasChanged) {
        if (await this.notify(tgId, updatedMessage(email, expiryTime, isEnabled, notificationServer))) {
          notificationsSent += 1;
        }
        if (expiryTime > now) isExpiredNotified = 0;
        if (expiryChanged) lastExpiryReminderDay = null;
      } else if (expiryTime > now) {
        const days = remainingDays(expiryTime, now);
        const today = notificationDay(now);
        if (days >= 1 && days <= 3 && lastExpiryReminderDay !== today) {
          if (await this.notify(tgId, expiringSoonMessage(email, expiryTime, days, notificationServer))) {
            notificationsSent += 1;
          }
          // Record the attempt so a frequent audit cannot repeatedly message one user.
          lastExpiryReminderDay = today;
        } else if (days > 3) {
          lastExpiryReminderDay = null;
        }
      }
    }

    return {
      email,
      expiryTime,
      isEnabled,
      isExpiredNotified,
      lastExpiryReminderDay,
      notificationsSent,
      tgId
    };
  }
}

module.exports = {
  NotificationPolicy,
  escapeMarkdown,
  isValidTelegramId,
  normaliseEnabled,
  normaliseExpiryTime,
  remainingDays,
  serverLabel,
  serverLine
};
