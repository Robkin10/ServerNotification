const {
  deleteClientStatesAbsentFromPanel,
  getClientState,
  listClientStatesForServer,
  listTrackedServers,
  upsertClientState
} = require('./database');
const {
  createThreeXuiService,
  fetchClientDetails,
  fetchClientLinks,
  fetchClients
} = require('./panelApi');
const { sendDirectMessage } = require('./telegram');
const { AuditService } = require('./tracker/auditService');
const { LinkDeliveryService, clientLinkMessage } = require('./tracker/linkDeliveryService');
const {
  NotificationPolicy,
  isValidTelegramId,
  normaliseEnabled,
  normaliseExpiryTime,
  remainingDays
} = require('./tracker/notificationPolicy');
const { PanelSourceFactory } = require('./tracker/panelSourceFactory');
const { CoalescingAuditGuard, KeyedRunGuard } = require('./tracker/runGuards');
const { TestNotificationService } = require('./tracker/testNotificationService');

/**
 * Application-facing facade for tracker operations. The implementation is
 * composed from focused services so audit, notification, cache, link-delivery,
 * and concurrency rules can change independently.
 */
class TrackerEngine {
  constructor(options = {}) {
    const legacySourcesProvided = typeof options.listClients === 'function' || typeof options.getClientDetails === 'function';
    this.multiServerMode = !legacySourcesProvided;
    this.now = options.now || (() => Date.now());
    this.logger = options.logger || console;

    const sourceFactory = new PanelSourceFactory({
      multiServerMode: this.multiServerMode,
      listClients: options.listClients || fetchClients,
      getClientDetails: options.getClientDetails || fetchClientDetails,
      getClientLinks: options.getClientLinks || fetchClientLinks,
      createPanelService: options.createPanelService || createThreeXuiService,
      twoFactorCode: options.twoFactorCode || (() => process.env.THREEXUI_TWO_FACTOR_CODE)
    });
    const notify = options.notify || sendDirectMessage;
    const listServers = options.listServers || listTrackedServers;
    const notificationPolicy = new NotificationPolicy({
      now: this.now,
      notify,
      multiServerMode: this.multiServerMode
    });

    this.auditService = new AuditService({
      multiServerMode: this.multiServerMode,
      listServers,
      sourceFactory,
      deleteClientStatesAbsentFromPanel: options.deleteClientStatesAbsentFromPanel || deleteClientStatesAbsentFromPanel,
      getState: options.getState || getClientState,
      saveState: options.saveState || upsertClientState,
      notificationPolicy,
      logger: this.logger,
      now: this.now
    });
    this.testNotificationService = new TestNotificationService({
      multiServerMode: this.multiServerMode,
      listServers,
      sourceFactory,
      notify,
      logger: this.logger
    });
    this.linkDeliveryService = new LinkDeliveryService({
      listClientStatesForServer: options.listClientStatesForServer || listClientStatesForServer,
      notify
    });
    this.auditGuard = new CoalescingAuditGuard();
    this.operationGuard = new KeyedRunGuard();
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

  async performAudit({ serverIds } = {}) {
    const startedAt = new Date(this.now()).toISOString();
    this.status = { ...this.status, running: true, lastStartedAt: startedAt, lastError: null };
    const { result, errorMessage } = await this.auditService.run({ serverIds, startedAt });
    return this.finishAudit(result, startedAt, errorMessage);
  }

  async runAudit({ serverIds } = {}) {
    return this.auditGuard.run({
      serverIds,
      execute: (requestedServerIds) => this.performAudit({ serverIds: requestedServerIds }),
      skippedResult: () => ({ ...this.status.lastResult, skipped: true })
    });
  }

  async sendTestNotifications() {
    return this.operationGuard.run('test-notifications', {
      execute: () => this.testNotificationService.send(),
      skippedResult: () => ({ success: false, skipped: true, recipients: 0, sent: 0, failed: 0, detailFailures: 0 })
    });
  }

  async sendClientLinks(server, options = {}) {
    const serverId = Number(server?.id);
    if (!Number.isSafeInteger(serverId) || serverId < 1) {
      return this.linkDeliveryService.send(server, options);
    }
    return this.operationGuard.run(`link-delivery:${serverId}`, {
      execute: () => this.linkDeliveryService.send(server, options),
      skippedResult: () => ({
        success: false, skipped: true, clientsChecked: 0, linksPrepared: 0,
        sent: 0, failed: 0, skippedClients: 0, missingTelegram: 0,
        validationFailures: 0, detailFailures: 0, linkFailures: 0
      })
    });
  }
}

module.exports = {
  TrackerEngine,
  isValidTelegramId,
  clientLinkMessage,
  normaliseEnabled,
  normaliseExpiryTime,
  remainingDays
};
