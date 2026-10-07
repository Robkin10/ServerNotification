const assert = require('node:assert/strict');
const test = require('node:test');
const { createTelegramNotifier, welcomeMessage } = require('../telegram');

test('uses the installed Telegram v2 Bot API to send a Markdown direct message', async () => {
  const sent = [];
  const notifier = createTelegramNotifier({
    token: 'test-token',
    logger: { error() {} },
    createBot: () => ({
      api: {
        sendMessage: async (payload) => sent.push(payload)
      }
    })
  });

  assert.equal(await notifier.sendDirectMessage(123, '*hello*'), true);
  assert.deepEqual(sent, [{ chat_id: '123', text: '*hello*', parse_mode: 'Markdown' }]);
});

test('reports a chat-permission failure without throwing', async () => {
  const errors = [];
  const notifier = createTelegramNotifier({
    token: 'test-token',
    logger: { error: (message) => errors.push(message) },
    createBot: () => ({
      api: {
        sendMessage: async () => {
          const error = new Error('forbidden');
          error.errorCode = 403;
          throw error;
        }
      }
    })
  });

  assert.equal(await notifier.sendDirectMessage(123, '*hello*'), false);
  assert.deepEqual(errors, ['A Telegram recipient has blocked the bot or has not started it (403).']);
});

test('requires the dedicated notification-bot token rather than a panel bot token', async () => {
  const errors = [];
  const notifier = createTelegramNotifier({
    token: '',
    logger: { error: (message) => errors.push(message) },
    createBot: () => {
      throw new Error('must not create a bot without a notification token');
    }
  });

  assert.equal(await notifier.sendDirectMessage(123, '*hello*'), false);
  assert.deepEqual(errors, ['NOTIFICATION_TELEGRAM_BOT_TOKEN is required for outgoing notifications.']);
});

test('replies to a private /start with the linked VLESS subscription details', async () => {
  const sent = [];
  let startHandler;
  let searchedChatId;
  const bot = {
    api: { sendMessage: async (payload) => sent.push(payload) },
    command: (name, handler) => {
      assert.equal(name, 'start');
      startHandler = handler;
      return bot;
    },
    catch: () => bot,
    isRunning: () => false,
    startPolling: () => new Promise(() => {}),
    stop() {}
  };
  const notifier = createTelegramNotifier({
    token: 'notification-token',
    createBot: () => bot,
    logger: { error() {} },
    findClientsByTelegramId: async (chatId) => {
      searchedChatId = chatId;
      return [{
        email: 'alice@example.test', expiry_time: Date.UTC(2026, 0, 15), is_enabled: 1,
        group_name: 'Production', server_name: 'Japan'
      }];
    }
  });

  assert.equal(notifier.startWelcomeListener(), true);
  await startHandler({ chat: { type: 'private' }, chatId: 321 });

  assert.equal(searchedChatId, '321');
  assert.deepEqual(sent, [{
    chat_id: '321',
    text: welcomeMessage([{
      email: 'alice@example.test', expiry_time: Date.UTC(2026, 0, 15), is_enabled: 1,
      group_name: 'Production', server_name: 'Japan'
    }]),
    parse_mode: 'Markdown'
  }]);
  assert.match(sent[0].text, /Welcome to Secure Access/);
  assert.match(sent[0].text, /Username:\* `alice@example\.test`/);
  assert.match(sent[0].text, /Expiration Date:\* 15 Jan 2026, 6:30 AM/);
});

test('does not disclose subscription details for /start commands in group chats', async () => {
  let startHandler;
  const notifier = createTelegramNotifier({
    token: 'notification-token',
    createBot: () => ({
      api: { sendMessage: async () => { throw new Error('must not send to a group'); } },
      command: (name, handler) => {
        assert.equal(name, 'start');
        startHandler = handler;
      },
      catch() {},
      isRunning: () => false,
      startPolling: () => new Promise(() => {})
    }),
    logger: { error() {} },
    findClientsByTelegramId: async () => { throw new Error('must not query for a group'); }
  });

  assert.equal(notifier.startWelcomeListener(), true);
  await startHandler({ chat: { type: 'group' }, chatId: -100 });
});
