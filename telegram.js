const { Bot } = require('node-telegram-bot-api');
const { listClientStatesForTelegram } = require('./database');

function escapeMarkdown(value) {
  return String(value ?? '').replace(/([_`*\[\]])/g, '\\$1');
}

function formatExpiration(expiryTime) {
  const timestamp = Number(expiryTime);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'No expiration date';
  return new Intl.DateTimeFormat('en', {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC'
  }).format(new Date(timestamp));
}

function subscriptionStatus(client, now = Date.now()) {
  if (Number(client.expiry_time) > 0 && Number(client.expiry_time) <= now) return 'Expired';
  return Number(client.is_enabled) === 1 || client.is_enabled === true ? 'Active' : 'Disabled';
}

function welcomeMessage(clients, now = Date.now()) {
  const validClients = Array.isArray(clients) ? clients : [];
  const heading = [
    '🎉 *Welcome to Secure Access!*',
    '',
    'Hi there! Your account setup is complete, and your subscription details are configured below.'
  ];

  if (!validClients.length) {
    return [
      ...heading,
      '',
      'Your Telegram account is not linked to a subscription yet. Please contact support if you believe this is incorrect.',
      '',
      '🔔 _Once linked, you will receive automated renewal reminders here._'
    ].join('\n');
  }

  const accounts = validClients.map((client, index) => [
    '',
    `📊 *Account Information${validClients.length > 1 ? ` ${index + 1}` : ''}:*`,
    '',
    `- *Username:* \`${escapeMarkdown(client.email)}\``,
    `- *Status:* ${subscriptionStatus(client, now)}`,
    `- *Expiration Date:* ${formatExpiration(client.expiry_time)}`,
    ...(validClients.length > 1 && (client.group_name || client.server_name)
      ? [`- *Server:* ${escapeMarkdown([client.group_name, client.server_name].filter(Boolean).join(' / '))}`]
      : [])
  ]);

  return [
    ...heading,
    ...accounts.flat(),
    '',
    '🔔 _Note: You will receive automated notifications here when your subscription end date is approaching so you can renew without any service interruption._'
  ].join('\n');
}

function createTelegramNotifier({
  // This bot is intentionally independent from any bot configured in 3X-UI.
  token = process.env.NOTIFICATION_TELEGRAM_BOT_TOKEN,
  createBot = (botToken) => new Bot(botToken),
  findClientsByTelegramId = listClientStatesForTelegram,
  welcomeEnabled = process.env.TELEGRAM_WELCOME_ENABLED !== 'false',
  logger = console
} = {}) {
  let bot;
  let welcomeHandlerRegistered = false;
  let pollingPromise = null;

  function getBot() {
    if (!bot) {
      if (!token?.trim()) {
        throw new Error('NOTIFICATION_TELEGRAM_BOT_TOKEN is required.');
      }
      bot = createBot(token);
    }
    return bot;
  }

  async function sendDirectMessage(chatId, markdownText) {
    try {
      await getBot().api.sendMessage({
        chat_id: String(chatId),
        text: markdownText,
        parse_mode: 'Markdown'
      });
      return true;
    } catch (error) {
      const errorCode = error?.errorCode || error?.response?.body?.error_code || error?.response?.statusCode;
      if (error?.message === 'NOTIFICATION_TELEGRAM_BOT_TOKEN is required.') {
        logger.error('NOTIFICATION_TELEGRAM_BOT_TOKEN is required for outgoing notifications.');
      } else if (errorCode === 401) {
        logger.error('Telegram rejected the bot token (401).');
      } else if (errorCode === 403) {
        logger.error('A Telegram recipient has blocked the bot or has not started it (403).');
      } else if (errorCode === 400) {
        logger.error('Telegram rejected the recipient or message payload (400).');
      } else {
        logger.error('Unable to send a Telegram notification.');
      }
      return false;
    }
  }

  async function handleStart(context) {
    // Subscription chat IDs are individual users. Do not leak account details
    // if somebody uses /start in a group chat.
    if (context?.chat?.type && context.chat.type !== 'private') return;
    const chatId = context?.chatId ?? context?.message?.chat?.id;
    if (chatId === undefined || chatId === null) return;

    let clients = [];
    try {
      clients = await findClientsByTelegramId(String(chatId));
    } catch {
      logger.error('Unable to look up subscription details for a Telegram /start request.');
    }
    await sendDirectMessage(chatId, welcomeMessage(clients));
  }

  function startWelcomeListener() {
    if (!welcomeEnabled) return false;
    try {
      const notificationBot = getBot();
      if (typeof notificationBot.command !== 'function' || typeof notificationBot.startPolling !== 'function') {
        throw new Error('Installed Telegram bot client does not support command polling.');
      }
      if (!welcomeHandlerRegistered) {
        notificationBot.command('start', handleStart);
        if (typeof notificationBot.catch === 'function') {
          notificationBot.catch(() => logger.error('Unable to process a Telegram bot update.'));
        }
        welcomeHandlerRegistered = true;
      }
      if (pollingPromise || notificationBot.isRunning?.()) return true;
      pollingPromise = Promise.resolve(notificationBot.startPolling())
        .catch(() => logger.error('Telegram welcome-message polling stopped unexpectedly.'))
        .finally(() => { pollingPromise = null; });
      return true;
    } catch {
      logger.error('Telegram welcome-message polling could not be started.');
      return false;
    }
  }

  async function stopWelcomeListener() {
    if (!bot || !pollingPromise) return;
    if (typeof bot.stop === 'function') bot.stop();
    await pollingPromise;
  }

  return { sendDirectMessage, startWelcomeListener, stopWelcomeListener };
}

const defaultNotifier = createTelegramNotifier();

module.exports = {
  createTelegramNotifier,
  formatExpiration,
  sendDirectMessage: defaultNotifier.sendDirectMessage,
  startWelcomeListener: defaultNotifier.startWelcomeListener,
  stopWelcomeListener: defaultNotifier.stopWelcomeListener,
  subscriptionStatus,
  welcomeMessage
};
