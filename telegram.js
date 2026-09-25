const { Bot } = require('node-telegram-bot-api');

function createTelegramNotifier({
  // This bot is intentionally independent from any bot configured in 3X-UI.
  // It has no polling or panel privileges; it only delivers tracker messages.
  token = process.env.NOTIFICATION_TELEGRAM_BOT_TOKEN,
  createBot = (botToken) => new Bot(botToken),
  logger = console
} = {}) {
  let bot;

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

  return { sendDirectMessage };
}

const defaultNotifier = createTelegramNotifier();

module.exports = {
  createTelegramNotifier,
  sendDirectMessage: defaultNotifier.sendDirectMessage
};
