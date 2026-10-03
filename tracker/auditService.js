const { ThreeXuiApiError } = require('../panelApi');
const { resolveLinkCache, emailKey } = require('./linkCache');

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
    clientDetailsFailed: 0,
    clientLinksFetched: 0,
    clientLinksFailed: 0,
    clientLinksUpdated: 0,
    clientsRemoved: 0
  };
  if (multiServerMode) {
    result.serversConfigured = 0;
    result.serversAudited = 0;
    result.serversFailed = 0;
  }
  return result;
}

/** Synchronizes saved panel clients and delegates notification state decisions. */
class AuditService {
  constructor({
    multiServerMode,
    listServers,
    sourceFactory,
    deleteClientStatesAbsentFromPanel,
    getState,
    saveState,
    notificationPolicy,
    logger = console,
    now = () => Date.now()
  }) {
    this.multiServerMode = multiServerMode;
    this.listServers = listServers;
    this.sourceFactory = sourceFactory;
    this.deleteClientStatesAbsentFromPanel = deleteClientStatesAbsentFromPanel;
    this.getState = getState;
    this.saveState = saveState;
    this.notificationPolicy = notificationPolicy;
    this.logger = logger;
    this.now = now;
  }

  async getPreviousState(server, clientId) {
    return this.multiServerMode ? this.getState(server.id, clientId) : this.getState(clientId);
  }

  async saveClientState(server, clientId, state, vlessLinks) {
    if (this.multiServerMode) {
      return this.saveState(
        server.id, clientId, state.tgId, state.email, state.expiryTime, state.isEnabled,
        state.isExpiredNotified, state.lastExpiryReminderDay, vlessLinks
      );
    }
    return this.saveState(
      clientId, state.tgId, state.email, state.expiryTime, state.isEnabled,
      state.isExpiredNotified, state.lastExpiryReminderDay, vlessLinks
    );
  }

  async auditClient(server, client, result, refreshedLinks) {
    const clientId = typeof client.email === 'string' ? client.email.trim() : '';
    if (!clientId) return;

    const previous = await this.getPreviousState(server, clientId);
    const { linksChanged, vlessLinks } = resolveLinkCache(previous, refreshedLinks);
    const state = await this.notificationPolicy.evaluate({ client, previous, server });

    if (linksChanged) result.clientLinksUpdated += 1;
    result.notificationsSent += state.notificationsSent;
    await this.saveClientState(server, clientId, state, vlessLinks);
    result.clientsTracked += 1;
  }

  async auditServer(server, result) {
    const source = await this.sourceFactory.create(server);
    if (!Array.isArray(source.clients)) {
      throw new Error('Panel client response did not contain an array.');
    }

    // A malformed list cannot be used to infer deletion. Audit valid entries,
    // but retain local state until the panel returns a complete usable list.
    const panelClientIds = this.completePanelClientIds(source.clients);

    result.clientsFetched += source.clients.length;
    for (const clientSummary of source.clients) {
      if (!clientSummary || typeof clientSummary !== 'object' || typeof clientSummary.email !== 'string' || !clientSummary.email.trim()) {
        result.invalidClients += 1;
        continue;
      }

      try {
        const details = await source.getClientDetails(clientSummary.email);
        const client = { ...clientSummary, ...details, email: details.email || clientSummary.email };
        result.clientDetailsFetched += 1;
        let refreshedLinks;
        if (emailKey(details?.email) === emailKey(clientSummary.email)) {
          try {
            refreshedLinks = await source.getClientLinks(details.email);
            result.clientLinksFetched += 1;
          } catch {
            result.clientLinksFailed += 1;
          }
        } else {
          result.clientLinksFailed += 1;
        }
        await this.auditClient(server, client, result, refreshedLinks);
      } catch {
        result.clientDetailsFailed += 1;
      }
    }

    if (this.multiServerMode && panelClientIds !== null) {
      result.clientsRemoved += await this.deleteClientStatesAbsentFromPanel(server.id, panelClientIds);
    }
  }

  completePanelClientIds(clients) {
    const clientIds = new Set();
    for (const client of clients) {
      if (!client || typeof client !== 'object' || typeof client.email !== 'string') return null;
      const email = client.email.trim();
      if (!email) return null;
      clientIds.add(email.toLowerCase());
    }
    return [...clientIds];
  }

  async run({ serverIds, startedAt }) {
    const result = createAuditResult(this.now(), this.multiServerMode);
    result.startedAt = startedAt;
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
          this.logger.info('Audit skipped: no enabled servers are configured.');
          return { result, errorMessage: 'No enabled servers are configured.' };
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
          const label = [server.group_name, server.name].filter(Boolean).join(' / ');
          failures.push(`${label || 'Configured server'}: ${panelErrorMessage(error)}`);
          this.logger.error(`Audit failed for ${label || 'a configured server'}: ${panelErrorMessage(error)}`);
        }
      }

      result.success = failures.length === 0;
      const errorMessage = failures.length ? failures.join(' ') : null;
      this.logger.info(`Audit complete: synchronized ${result.clientsTracked} VLESS client(s).`);
      return { result, errorMessage };
    } catch (error) {
      const errorMessage = panelErrorMessage(error);
      this.logger.error(`Audit failed: ${errorMessage}`);
      return { result, errorMessage };
    }
  }
}

module.exports = { AuditService, createAuditResult, panelErrorMessage };
