/** Serializes audits while preserving server-specific audit requests that arrive mid-run. */
class CoalescingAuditGuard {
  constructor({ schedule = (callback) => setImmediate(callback) } = {}) {
    this.schedule = schedule;
    this.running = false;
    this.queuedServerIds = new Set();
  }

  async run({ serverIds, execute, skippedResult }) {
    if (this.running) {
      if (Array.isArray(serverIds)) {
        for (const serverId of serverIds) this.queuedServerIds.add(Number(serverId));
      }
      return skippedResult();
    }

    this.running = true;
    try {
      return await execute(serverIds);
    } finally {
      this.running = false;
      if (this.queuedServerIds.size) {
        const queuedServerIds = [...this.queuedServerIds];
        this.queuedServerIds.clear();
        this.schedule(() => this.run({ serverIds: queuedServerIds, execute, skippedResult }));
      }
    }
  }
}

/** Prevents duplicate non-idempotent operations for an individual resource. */
class KeyedRunGuard {
  constructor() {
    this.activeKeys = new Set();
  }

  async run(key, { execute, skippedResult }) {
    if (this.activeKeys.has(key)) return skippedResult();
    this.activeKeys.add(key);
    try {
      return await execute();
    } finally {
      this.activeKeys.delete(key);
    }
  }
}

module.exports = { CoalescingAuditGuard, KeyedRunGuard };
