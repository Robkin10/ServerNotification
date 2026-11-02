const { emailKey, normaliseClientLinks } = require('./linkUtils');
const { escapeMarkdown, isValidTelegramId, serverLine } = require('./notificationPolicy');

function clientLinkMessage(email, server, link) {
  return [
    '*Your VLESS Key link*',
    '',
    serverLine(server),
    `Email: \`${escapeMarkdown(email)}\``,
    '',
    'Import or Paste this link into your VLESS client:',
    // This is a legacy Telegram Markdown code entity. Escaping inside it is
    // forbidden and would corrupt URI characters such as `_` when copied.
    `\`${String(link ?? '')}\``
  ].filter(Boolean).join('\n');
}

/** Fetches and sends current panel links for tracked, server-scoped recipients. */
class LinkDeliveryService {
  constructor({ listClientStatesForServer, createLinkSource, notify }) {
    this.listClientStatesForServer = listClientStatesForServer;
    this.createLinkSource = createLinkSource;
    this.notify = notify;
  }

  async send(server, { clientEmail } = {}) {
    const serverId = Number(server?.id);
    if (!Number.isSafeInteger(serverId) || serverId < 1) {
      throw new Error('A saved server is required for client link delivery.');
    }
    const requestedEmail = clientEmail === undefined ? null : emailKey(clientEmail);
    if (clientEmail !== undefined && !requestedEmail) {
      throw new Error('A client email is required for individual link delivery.');
    }

    const clients = await this.listClientStatesForServer(serverId);
    if (!Array.isArray(clients)) {
      throw new Error('Stored client link data did not contain a client array.');
    }

    const result = {
      success: true,
      skipped: false,
      clientsChecked: 0,
      linksPrepared: 0,
      sent: 0,
      failed: 0,
      skippedClients: 0,
      missingTelegram: 0,
      validationFailures: 0,
      detailFailures: 0,
      linkFailures: 0
    };
    const checkedEmails = new Set();
    let linkSourcePromise;

    const freshLinksFor = async (client) => {
      if (!linkSourcePromise) linkSourcePromise = this.createLinkSource(server);
      const linkSource = await linkSourcePromise;
      return normaliseClientLinks(await linkSource.getClientLinks(client.email));
    };

    for (const client of clients) {
      const storedEmail = emailKey(client?.email);
      if (!storedEmail || checkedEmails.has(storedEmail)) continue;
      if (requestedEmail && storedEmail !== requestedEmail) continue;
      checkedEmails.add(storedEmail);
      result.clientsChecked += 1;

      if (!isValidTelegramId(client.telegram_id)) {
        result.missingTelegram += 1;
        result.skippedClients += 1;
        continue;
      }

      let links;
      try {
        links = await freshLinksFor(client);
      } catch {
        result.linkFailures += 1;
        result.skippedClients += 1;
        continue;
      }
      if (!links.length) {
        result.linkFailures += 1;
        result.skippedClients += 1;
        continue;
      }

      result.linksPrepared += links.length;
      const recipientId = String(client.telegram_id).trim();
      for (const link of links) {
        try {
          if (await this.notify(recipientId, clientLinkMessage(client.email, server, link))) result.sent += 1;
          else result.failed += 1;
        } catch {
          result.failed += 1;
        }
      }
    }

    return result;
  }
}

module.exports = { LinkDeliveryService, clientLinkMessage };
