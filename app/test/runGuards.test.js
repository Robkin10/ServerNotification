const assert = require('node:assert/strict');
const test = require('node:test');
const { CoalescingAuditGuard, KeyedRunGuard } = require('../tracker/runGuards');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('coalesces server-specific audits requested while an audit is running', async () => {
  const firstRun = deferred();
  const followUpStarted = deferred();
  const runs = [];
  const guard = new CoalescingAuditGuard();
  const execute = async (serverIds) => {
    runs.push(serverIds);
    if (runs.length === 1) await firstRun.promise;
    else followUpStarted.resolve();
    return { serverIds };
  };
  const skippedResult = () => ({ skipped: true });

  const first = guard.run({ execute, skippedResult });
  const skipped = await guard.run({ serverIds: [7, 9, 7], execute, skippedResult });
  assert.deepEqual(skipped, { skipped: true });

  firstRun.resolve();
  await first;
  await followUpStarted.promise;
  assert.deepEqual(runs, [undefined, [7, 9]]);
});

test('rejects duplicate work for a resource until the active work finishes', async () => {
  const release = deferred();
  const guard = new KeyedRunGuard();
  const first = guard.run('server:4', {
    execute: async () => {
      await release.promise;
      return 'complete';
    },
    skippedResult: () => 'skipped'
  });

  assert.equal(await guard.run('server:4', {
    execute: async () => 'unexpected',
    skippedResult: () => 'skipped'
  }), 'skipped');
  release.resolve();
  assert.equal(await first, 'complete');
});
