const DEFAULT_NOTIFICATION_TIME_ZONE = 'Asia/Yangon';

function notificationTimeZone() {
  const configured = String(process.env.NOTIFICATION_TIME_ZONE || '').trim();
  if (!configured) return DEFAULT_NOTIFICATION_TIME_ZONE;

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: configured });
    return configured;
  } catch {
    return DEFAULT_NOTIFICATION_TIME_ZONE;
  }
}

function dateParts(timestamp, timeZone = notificationTimeZone()) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hourCycle: 'h12'
    })
      .formatToParts(new Date(timestamp))
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value }) => [type, value])
  );
}

function formatNotificationDate(expiryTime) {
  const timestamp = Number(expiryTime);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'No expiration date';

  const parts = dateParts(timestamp);
  return `${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} ${parts.dayPeriod}`;
}

function notificationDay(timestamp) {
  const parts = dateParts(timestamp);
  const monthNumber = new Intl.DateTimeFormat('en-US', {
    timeZone: notificationTimeZone(),
    month: '2-digit'
  }).format(new Date(timestamp));
  return `${parts.year}-${monthNumber}-${String(parts.day).padStart(2, '0')}`;
}

module.exports = {
  DEFAULT_NOTIFICATION_TIME_ZONE,
  formatNotificationDate,
  notificationDay,
  notificationTimeZone
};
