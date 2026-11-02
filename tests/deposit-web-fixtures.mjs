import { runTask } from '../src/task-runner.mjs';
import { createDemoDatabase, demoData } from '../src/demo/deposit-demo.mjs';

export function manualDepositFixture(browser, options = {}) {
  const state = demoData();
  // Neither user belongs to the fixture Sheets; direct input needs no membership.
  state.deposits = state.deposits.filter(row => row.username === 'demo.north').map(row => ({ ...row, username: 'manual.First' }));
  state.deposits.push({ username: '000123', key: '301', subscriberId: '30', isCovered: 0, isBundled: 0, refundable: 0 });
  return { state, execute: (job, callbacks) => runTask(job.taskId, job.input, {
    root: job.root, outputDir: job.outputDir, lockHeld: true, settings: job.settings, approvedDeposits: job.approvedDeposits, ...callbacks,
    openDepositSession: (tenant, config) => createDemoDatabase(browser, state, tenant, config, { ...options, manualGrid: true, actionColumns: true, stripSemicolon: true })
  }) };
}
